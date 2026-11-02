import { afterEach } from 'vitest'
import { resetDraftsForTests } from './lib/composer-drafts'

// Composer drafts outlive a component (lib/composer-drafts.ts): without this,
// text typed in one test shows up in the next test's composer.
afterEach(() => resetDraftsForTests())
