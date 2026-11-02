import http from 'node:http'
import { once } from 'node:events'
import { FIXTURE_VALUE as FAKE_PASSWORD, PAGE_TITLE } from '../fake-model/server.mjs'

export async function startFixture() {
  const events = [], requests = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid')
    requests.push({ at: performance.now(), path: url.pathname })
    if (url.pathname === '/event' || url.pathname === '/loaded') {
      events.push({ at: performance.now(), lane: url.searchParams.get('lane'),
        type: url.pathname === '/event' ? 'click' : 'load' })
      response.writeHead(204).end()
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><html><head><title>${PAGE_TITLE}</title></head>
      <body style="font:20px system-ui;background:#eaf5ff;padding:32px">
      <h1>${PAGE_TITLE}</h1><p>Local lane ${url.pathname.slice(1)}</p>
      <button onclick="fetch('/event?lane='+location.pathname.slice(1));this.textContent='Click recorded'">Record click</button>
      <script>addEventListener('DOMContentLoaded',()=>fetch('/loaded?lane='+location.pathname.slice(1)))</script>
      ${url.pathname === '/login' ? `<form><label>Email <input type="email" value="fixture@example.invalid"></label>
      <label>Password <input type="password" autocomplete="current-password"></label></form>
      <script>document.forms[0].elements[1].value=${JSON.stringify(FAKE_PASSWORD)}</script>` : ''}
      </body></html>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}`, events, requests,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    } }
}
