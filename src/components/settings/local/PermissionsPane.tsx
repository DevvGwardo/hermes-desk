import { requestOpenSettings } from '../../../lib/open-settings'
import { ComputerPane } from './ComputerPane'
import { SecretsPane } from './SecretsPane'
import { Card, buttonClass, hintClass, type LocalSettingsState } from './common'

export function PermissionsPane(state: LocalSettingsState) {
  return <>
    <Card id="tool-permissions" title="Tool permissions">
      <p className={hintClass}>One-time approvals cover one action. Broader grants cover matching actions for the session or profile. Change an agent’s approval policy in Agents. Revoke saved grants in that profile’s command allowlist, then start a new session.</p>
      <button type="button" className={`${buttonClass} mt-3`} onClick={() => requestOpenSettings('capabilities')}>Agent approval policy</button>
    </Card>
    <Card id="browser-permissions" title="Browser access">
      <p className={hintClass}>Each agent has an isolated browser lane. Enable browsing and choose allowed or blocked websites per agent in Workspace. Moving a page does not copy sign-in data.</p>
      <button type="button" className={`${buttonClass} mt-3`} onClick={() => requestOpenSettings('workspace')}>Workspace permissions</button>
    </Card>
    <ComputerPane {...state} />
    <SecretsPane {...state} />
  </>
}
