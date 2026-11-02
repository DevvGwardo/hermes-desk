// Fixed trusted macOS observer/self-probe; no arbitrary native payload evaluator.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <limits.h>
#include <unistd.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <spawn.h>
#include <sys/wait.h>
#include <CommonCrypto/CommonDigest.h>
extern char **environ;
typedef int (*check_fn)(pid_t,const char*,int,...);
typedef int (*init_fn)(const char*,uint64_t,char**);
typedef int (*params_fn)(const char*,uint64_t,const char*const*,char**);
static check_fn check;static int quiet;
static void field(pid_t pid,const char *op,int filter,const char *arg) {
  errno=0;int r=filter?check(pid,op,filter|quiet,arg):check(pid,op,quiet);int e=errno;
  printf("{\"rc\":%d,\"errno\":%d}",r,e);
}
static uint64_t socket_id(pid_t pid,int fd) {
  struct socket_fdinfo s;
  if(proc_pidfdinfo(pid,fd,PROC_PIDFDSOCKETINFO,&s,sizeof(s))!=(int)sizeof(s))return 0;
  return s.psi.soi_so;
}
int main(int argc,char **argv) {
  if(argc==5&&!strcmp(argv[1],"--launch")) {
    const char *suffix="/control/policy.sb";size_t n=strlen(argv[2]),s=strlen(suffix);
    if(n<=s||strcmp(argv[2]+n-s,suffix))return 2;
    char root[PATH_MAX],expected[PATH_MAX],parameter[64];
    if(n-s>=sizeof(root))return 2;memcpy(root,argv[2],n-s);root[n-s]=0;
    snprintf(expected,sizeof(expected),"%s/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",root);
    if(strcmp(expected,argv[3]))return 2;
    snprintf(expected,sizeof(expected),"%s/control/entry.cjs",root);if(strcmp(expected,argv[4]))return 2;
    snprintf(parameter,sizeof(parameter),"BROWSER_PID=%d",getpid());
    // Fixed executable, fixed entry, fixed flags. Not an arbitrary native exec
    // or script interpreter; PID survives this exec and binds Mach registration.
    char *args[]={"/usr/bin/sandbox-exec","-D",parameter,"-f",argv[2],argv[3],
      "--in-process-gpu","--enable-features=NetworkServiceInProcess2","--disable-gpu",
      "--disable-background-networking","--disable-component-update","--disable-breakpad",
      "--disable-domain-reliability","--disable-sync","--no-first-run",
      "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",argv[4],0};
    execve(args[0],args,environ);return 7;
  }
  void *h=dlopen("/usr/lib/libsandbox.1.dylib",RTLD_NOW);
  const int *q=h?dlsym(h,"SANDBOX_CHECK_NO_REPORT"):0;check=h?dlsym(h,"sandbox_check"):0;
  if(!q||!check)return 3;quiet=*q;
  if(argc==5&&!strcmp(argv[1],"--self")) {
    FILE *f=fopen(argv[2],"rb");if(!f)return 4;
    char profile[65536];size_t n=fread(profile,1,sizeof(profile)-1,f);fclose(f);
    if(n>=sizeof(profile)-1)return 4;profile[n]=0;
    params_fn init=dlsym(h,"sandbox_init_with_parameters");char *error=0,pidText[32];
    snprintf(pidText,sizeof(pidText),"%d",getpid());
    const char *params[]={"BROWSER_PID",pidText,0};
    if(!init||init(profile,0,params,&error))return 5;
    errno=0;int rd=open(argv[3],O_RDONLY),re=errno;if(rd>=0)close(rd);
    errno=0;int wr=open(argv[3],O_WRONLY|O_APPEND),we=errno;if(wr>=0)close(wr);
    errno=0;int gr=open(argv[4],O_WRONLY|O_APPEND),ge=errno;if(gr>=0)close(gr);
    int s=socket(AF_INET,SOCK_STREAM,0),ne=errno,nr=-1;
    if(s>=0){struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(9),.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
      errno=0;nr=connect(s,(void*)&a,sizeof(a));ne=errno;close(s);}
    pid_t p=0;char *args[]={"/usr/bin/true",0};int sr=posix_spawn(&p,args[0],0,0,args,environ);
    if(!sr)waitpid(p,0,0);
    printf("{\"read\":{\"rc\":%d,\"errno\":%d},\"write\":{\"rc\":%d,\"errno\":%d},\"graphWrite\":{\"rc\":%d,\"errno\":%d},\"network\":{\"rc\":%d,\"errno\":%d},\"spawnErrno\":%d}\n",rd,re,wr,we,gr,ge,nr,ne,sr);
    return 0;
  }
  if(argc<4||strcmp(argv[1],"--observe")||argc>600)return 2;
  char *end=0;long number=strtol(argv[2],&end,10);if(!end||*end||number<1||number>INT_MAX)return 2;
  long peer=strtol(argv[3],&end,10);if(!end||*end||peer<1||peer>INT_MAX)return 2;
  pid_t pid=(pid_t)number;struct proc_bsdinfo b;char executable[PROC_PIDPATHINFO_MAXSIZE];
  if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&b,sizeof(b))!=(int)sizeof(b)||proc_pidpath(pid,executable,sizeof(executable))<=0)return 6;
  // Executable paths are compared by hash externally; printable paths only.
  if(strchr(executable,'"')||strchr(executable,'\\')||strchr(executable,'\n'))return 6;
  printf("{\"pid\":%d,\"ppid\":%d,\"startSec\":%llu,\"startUsec\":%llu,\"executable\":\"%s\",\"privateSocket\":\"%llu\",\"sockets\":[",
    pid,b.pbi_ppid,(unsigned long long)b.pbi_start_tvsec,(unsigned long long)b.pbi_start_tvusec,executable,
    (unsigned long long)socket_id(pid,3));
  struct proc_fdinfo fds[1024];int size=proc_pidinfo(pid,PROC_PIDLISTFDS,0,fds,sizeof(fds));
  if(size<0||size==(int)sizeof(fds))return 6;
  int first=1;
  for(int i=0;i<size/(int)sizeof(fds[0]);i++)if(fds[i].proc_fdtype==PROX_FDTYPE_SOCKET) {
    uint64_t id=socket_id(pid,(int)fds[i].proc_fd);if(!id)continue;
    printf("%s\"%llu\"",first?"":",",(unsigned long long)id);first=0;
  }
  printf("],\"paths\":[");
  const char *ops[]={"file-read-data","file-write-data","file-write-unlink","file-write-create"};
  for(int i=4;i<argc;i++){
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(argv[i],(CC_LONG)strlen(argv[i]),digest);
    printf("%s{\"pathDigest\":\"",i==4?"":",");
    for(int k=0;k<CC_SHA256_DIGEST_LENGTH;k++)printf("%02x",digest[k]);
    printf("\"");
    for(int j=0;j<4;j++){
      printf(",\"%s\":",ops[j]);field(pid,ops[j],1,argv[i]);}printf("}");}
  printf("],\"mach\":{");
  const char *names[]={"com.apple.SecurityServer","com.apple.tccd","com.apple.tccd.system","com.apple.pasteboard.1",
    "com.apple.coreservices.launchservicesd","com.github.Electron.MachPortRendezvousServer.unrelated"};
  for(int i=0;i<6;i++){printf("%s\"%s\":",i?",":"",names[i]);field(pid,"mach-lookup",2,names[i]);}
  char rendezvous[128],unrelated[128];
  snprintf(rendezvous,sizeof(rendezvous),"com.github.Electron.MachPortRendezvousServer.%ld",peer);
  snprintf(unrelated,sizeof(unrelated),"com.github.Electron.MachPortRendezvousServer.%ld",peer+100000);
  printf("},\"rendezvous\":{\"registerBrowser\":");field(pid,"mach-register",2,rendezvous);
  printf(",\"registerUnrelated\":");field(pid,"mach-register",2,unrelated);
  printf(",\"lookupBrowser\":");field(pid,"mach-lookup",2,rendezvous);
  printf(",\"lookupUnrelated\":");field(pid,"mach-lookup",2,unrelated);
  printf("},\"generic\":{");
  const char *generic[]={"network-outbound","network-inbound","network-bind","appleevent-send","process-fork"};
  for(int i=0;i<5;i++){printf("%s\"%s\":",i?",":"",generic[i]);field(pid,generic[i],0,0);}
  printf("}}\n");return 0;
}
