# Changelog

Every release of `@belaykit/core`, `@belaykit/rulebook` and `belaykit`, newest first. The three are released together,
at the same version. The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a minor version (0.2) may change the API.
[Upgrading](documentation/upgrading.md) says what to do for each change that can stop code written for an earlier
version.

## 0.2.0 - 2026-10-22

Upgrade all three together: `@belaykit/rulebook` 0.2 takes `@belaykit/core` 0.2 as its peer, and `belaykit` 0.2
depends on it.

### Added

- **`rules.decide(initial, { deps, maxIterations })`:** a rulebook that declares `outputs: [...]` works as a decision
  function. It returns the outputs' values, or `no_match` naming the unset outputs and the sections it tried, or
  `failed` with the run's error.
- **Guarded actions:** a registered action may declare `guard`, a CEL expression on `ws` that every rule naming the
  action must pass, checked again just before the action runs. A rulebook can narrow when an action runs, never widen
  it.
- **Templated params:** an action's `templates` names params a rule may fill from the case, with CEL placeholders in
  braces (`"{ws.customer.name} wrote"`), checked when the rulebook loads.
- **`belaykit.present(container, path)`:** whether a value is there, true when every key on the path exists and the
  last isn't `null`; the first of BelayKit's own CEL helpers, under the reserved name `belaykit`. Its path is a
  string literal, checked when the rulebook loads like the fields it reads.
- **`version`** in each package, and the rulebook's **`schemaVersions`**.
- **`exhaustive: false`** on a section: it needs no catch-all rule (its `when` ensures a rule holds, or a no-match
  should end the run).

### Changed

- **A `needs` key is gathered when it is present,** and absent until then: `initialize` no longer sets it to `null`,
  and refuses an initial working set that already holds it; `regather` removes it. A producer that returns `undefined`
  fails the run. A `needs` key that something wrote before its section ran counts as gathered, so its producer
  doesn't run. Code beside the rulebook (a finish checker, a code provider) that tested `ws.<key> === null` or read
  `ws.gathered` must test presence instead; a working set or result no longer holds `gathered`, nor `null` for a key
  never gathered.
- **A `FIRST` section with rules must say what happens when none holds:** it ends in a `when: "true"` rule (without
  `selectFirst`, on an action without a guard) or says `exhaustive: false`.
- **Stricter load checks:** a string compared with a field whose shape lists its values must be one of them; a key
  on a registered action or producer that BelayKit doesn't read is refused, for one made from a class too; a brace in a
  param the action doesn't template is refused; the name `belaykit` is reserved, and a registered method on `dyn` that
  would overlap a helper is refused.
- **The function reference** (`describeFunctions`, `belaykit-rulebook reference`) lists BelayKit's helpers before the
  registry's functions.
- **The default trace entry no longer has `durationMs`,** so two runs of the same case give the same trace. A tracer
  receives it in its second argument. In the types, `TraceEntry` loses `durationMs` and `WorkingSet` loses `gathered`.
- **A rule's params keep the key order the rulebook wrote them in,** now a documented promise.

### Removed

- `ws.gathered`. A rulebook that reads it fails to load, saying to test `has(ws.<key>)`.

### Fixed

- A mistake an expression makes twice (the same unknown key read twice, say) is reported once.
- A run that fails on a `when` gives cel-js's message in one line, without its excerpt of the source.
- A `selectFirst` binding named `belaykit` is reported alone, without a second, misleading type problem.
- A brace in an untemplated param is reported even when the action has an unrelated unknown key; only a misspelled
  `templates` that lists the param still accounts for it.

## 0.1.0 - 2026-10-20

The first release: `@belaykit/core` (the `Agent` loop, choice providers, `chain`, `always`), `@belaykit/rulebook`
(rulebooks in YAML and CEL, checked against a registry when they load; fixtures; the `belaykit-rulebook` command), and
`belaykit`, the core under its plain name.
