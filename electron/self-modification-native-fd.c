// Immutable trusted bootstrap only. No arbitrary FD or native payload delegate.
#define NAPI_VERSION 8
#include <node_api.h>
#include <fcntl.h>
static napi_value secure(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value argv[1],out;
  napi_get_cb_info(env,info,&argc,argv,0,0);
  if(argc!=0){napi_throw_error(env,0,"No native delegate arguments");return 0;}
  int flags=fcntl(3,F_GETFD);
  if(flags<0||fcntl(3,F_SETFD,flags|FD_CLOEXEC)<0||!(fcntl(3,F_GETFD)&FD_CLOEXEC)) {
    napi_throw_error(env,0,"Private fd close-on-exec installation failed");return 0;
  }
  napi_get_boolean(env,1,&out);return out;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value fn;napi_create_function(env,"securePrivateFd",NAPI_AUTO_LENGTH,secure,0,&fn);
  napi_set_named_property(env,exports,"securePrivateFd",fn);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
