// Launch the monorepo's Electron against the harness main process.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const monorepo = (process.env.DSH_MONOREPO ?? process.env.DSH_CHECKOUT ?? (() => { throw new Error('set DSH_CHECKOUT=/path/to/dsh (a dsh source checkout)') })())
const require = createRequire(join(monorepo, 'apps/desktop/package.json'))
const electron = require('electron')
const child = spawn(electron, [join(here, 'main.cjs')], { stdio: 'inherit', env: process.env })
child.on('exit', code => process.exit(code ?? 1))
