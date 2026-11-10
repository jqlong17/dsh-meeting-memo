#!/usr/bin/env node
/**
 * Verify the built `lib/client.js` the way the DSH web shell consumes it.
 *
 * 1. classic script, exactly one `__ModuleLoader__.load` record;
 * 2. id matches the package, factory is a function;
 * 3. requires stay inside the platform seed table;
 * 4. factory yields `apply` + `inject` with the three client services;
 * 5. `apply` registers one tab type and one tab body, effect-scoped;
 * 6. Chinese copy is present in the bundle.
 *
 * Dependency-free on purpose.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(repo, 'lib/client.js')
const PACKAGE_ID = 'dsh-meeting-minutes'
const PLATFORM_REQUIRES = ['react', 'react/jsx-runtime']
const TAB_KIND = 'meeting-minutes'
const LOCALE_NS = 'meeting-minutes'

const code = readFileSync(BUNDLE, 'utf8')

assert.ok(!/^\s*(?:import|export)\s/m.test(code),
  'bundle must not contain top-level ESM statements (the Host concatenates bundles as classic scripts)')

const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) {
        registrations.push(record)
      },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })
assert.equal(registrations.length, 1, 'bundle must register exactly one loader record')
const registration = registrations[0]
assert.equal(registration.id, PACKAGE_ID, `loader id must be "${PACKAGE_ID}"`)
assert.equal(typeof registration.factory, 'function', 'loader record must carry a factory function')

const required = [...new Set([...code.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]))]
const unexpected = required.filter((specifier) => !PLATFORM_REQUIRES.includes(specifier))
assert.deepEqual(unexpected, [], `bundle requires modules outside the platform seed table: ${unexpected.join(', ')}`)

const moduleStubs = {
  react: () => ({
    createElement: (type, props, ...children) => ({ $$typeof: 'element', type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    memo: (component) => component,
    Fragment: Symbol.for('react.fragment'),
    createContext: () => ({ Provider: () => null, Consumer: () => null }),
  }),
  'react/jsx-runtime': () => ({
    jsx: (type, props) => ({ $$typeof: 'element', type, props }),
    jsxs: (type, props) => ({ $$typeof: 'element', type, props }),
    Fragment: Symbol.for('react.fragment'),
  }),
}
const requireStub = (specifier) => {
  const stub = moduleStubs[specifier]
  assert.ok(stub, `factory required "${specifier}", which has no stub (platform seed only)`)
  return stub()
}
const plugin = registration.factory(requireStub)
assert.equal(typeof plugin.apply, 'function', 'plugin exports must expose apply()')
assert.ok(Array.isArray(plugin.inject), 'plugin exports must expose inject as an array')
for (const service of ['slots', 'sidebarRightTabs', 'locale']) {
  assert.ok(plugin.inject.includes(service), `plugin must inject "${service}"`)
}

const calls = { tabs: [], slots: [], locale: [], effects: 0 }
const fakeCtx = {
  effect(fn) {
    calls.effects += 1
    fn()
    return () => {}
  },
  slots: {
    inject(_name, fn) { return fn() },
    register(spec, component) {
      calls.slots.push({ spec, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      calls.tabs.push(definition)
      return () => {}
    },
  },
  locale: {
    register(ns, dictionaries) {
      calls.locale.push({ ns, dictionaries })
      return () => {}
    },
    bind() { return (key) => key },
  },
}

plugin.apply(fakeCtx)

assert.equal(calls.tabs.length, 1, 'apply must register exactly one tab type')
const tab = calls.tabs[0]
assert.equal(tab.id, PACKAGE_ID, 'tab definition id must equal the package name')
assert.equal(tab.kind, TAB_KIND, `tab kind must be "${TAB_KIND}"`)
assert.equal(tab.priority, 'extension', 'tab must declare the extension priority band')
assert.equal(typeof tab.title, 'function', 'tab definition must supply title()')
assert.ok(Array.isArray(tab.guide) && tab.guide.length >= 1, 'tab type must contribute a guide entry')

const bodies = calls.slots.filter((call) => call.spec?.name === 'sidebar.right.pane.tab')
assert.equal(bodies.length, 1, 'apply must register one right-sidebar body')
assert.equal(bodies[0].spec.key, PACKAGE_ID, 'tab body key must equal the tab id')
assert.equal(typeof bodies[0].component, 'function', 'tab body must carry a component')
assert.equal(typeof bodies[0].spec.inject, 'function', 'tab body must inject the rpc face')

assert.equal(calls.locale.length, 1, 'apply must register the locale dictionary')
assert.equal(calls.locale[0].ns, LOCALE_NS, `locale namespace must be "${LOCALE_NS}"`)
const dictionaries = calls.locale[0].dictionaries
assert.ok(dictionaries.zh && dictionaries.en, 'locale must ship zh and en')
for (const key of ['panel.tab.today', 'panel.tab.minutes', 'panel.density', 'panel.minutes.generate']) {
  assert.ok(dictionaries.zh[key] && dictionaries.en[key], `locale key ${key} must exist in zh and en`)
}

for (const needle of ['会议纪要', 'AI 生成纪要', 'VAD 语音密度', '最近 2 小时']) {
  assert.ok(code.includes(needle), `bundle must contain Chinese copy "${needle}"`)
}

console.log('[check-client] ok — tab, body, locale and copy verified')
