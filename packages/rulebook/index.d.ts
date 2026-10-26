import type { ChoiceProvider, Finalizer, FinishChecker, TraceEntry } from '@belaykit/core';

/**
 * A working set as a rulebook sees it: `ws` in CEL. Every key, a terminal field included, is the
 * agent's; a `needs` key is gathered when it is present and not `undefined`, as CEL's `has()` reads it
 * (since 0.2; there is no `gathered` list).
 */
export type WorkingSet = Record<string, unknown>;

/**
 * Fills one `needs` key. Returns the key's value; `null` is a valid answer ("looked, found
 * nothing") and counts as gathered. `undefined` fails the run (it would read as absent). Any other
 * key is a load problem (dependencies come through `deps`, for an entry made from a class too).
 */
export interface Producer<Deps = unknown> {
  /** The ws keys it sets — the loader's field rule uses this. */
  writes?: string[];
  run(ws: WorkingSet, deps: Deps): Promise<unknown>;
}

/** The item a `selectFirst` rule selected: its binding name, the item, and its index in the list. */
export interface SelectedItem {
  name: string;
  item: unknown;
  index: number;
}

/** What a registered action receives beside the working set. */
export interface ActionContext<Deps = unknown> {
  /**
   * The rule's literal `then:` fields, besides `action`, in the order the rule wrote them (at every
   * level), except that integer-like keys (`"1"`, `"20"`) come first in ascending order, as in any
   * JavaScript object; either way the order is the same on every run. A templated param holds its
   * filled text (the rule's own params keep the template). Read-only: frozen.
   */
  params: Readonly<Record<string, unknown>>;
  deps: Deps;
  /** Present when the rule has `selectFirst`; the index lets an agent replace the item rather than mutate it. */
  selected?: SelectedItem;
}

/**
 * A JSON Schema, draft 2020-12 (what zod 4's `z.toJSONSchema` writes); one without `$schema` is
 * read as 2020-12.
 */
export type JsonSchema = boolean | Record<string, unknown>;

/** An action a rule may name, with the keys it writes and the params it takes. */
export interface RegisteredAction<Deps = unknown> {
  writes?: string[];
  /**
   * The rule's `then:` fields besides `action`, as a JSON Schema for an object, checked at load.
   * Closed by default: unless it sets `additionalProperties` or `unevaluatedProperties` itself, a
   * param it doesn't name is refused. An action without one takes no params: a rule that passes
   * any is a load error.
   */
  params?: JsonSchema;
  /**
   * The params whose text a rule may fill from the case, with placeholders, CEL inside braces
   * (`"{ws.customer.name} wrote"`; `{{` and `}}` are literal braces). Each must be a top-level param
   * whose schema is a plain string (`type: "string"`, annotations only). Placeholders are checked at
   * load like a `when` and filled just before the action runs; a value that isn't a string, number or
   * boolean fails the run. A brace in a param the action doesn't template is a load error.
   */
  templates?: string[];
  /**
   * A CEL expression on `ws` that must hold for any rule to run this action (since 0.2). It is
   * evaluated before the rule's `when` (and selection), which aren't evaluated when it's false: the rule
   * doesn't match, with `detail: { guard: false }` in the trace. It's checked again just before the
   * action runs (in an `ALL` section an earlier action may have changed `ws`), and one that no longer
   * holds fails the run. Checked at load like a `when`, once
   * per action, for the actions a rulebook names; a guard that throws or isn't a boolean fails the run.
   * A last `when: "true"` rule whose action has a guard isn't a catch-all.
   */
  guard?: string;
  run(ws: WorkingSet, context: ActionContext<Deps>): Promise<void>;
}

/** A pure CEL function a rulebook may call. */
export interface RegisteredFunction {
  signature: string;
  handler: (...args: any[]) => unknown;
  /** Shown in the function reference. */
  description?: string;
  /** Parameter names and descriptions, in order, shown in the function reference. */
  params?: { name: string; description?: string }[];
  /**
   * Argument `key` names a field of argument `in`. A string-literal key passed with `ws` or
   * `ws.<key>` as its container is checked at load like the field reference `<in>.<key>`. Only for
   * global functions (`helper(a, b)`); a method with `keyArgs` is refused.
   */
  keyArgs?: { key: number; in: number };
}

/** What a rulebook may name. Each agent supplies its own, as a plain object in this shape. */
export interface Registry<Deps = unknown> {
  producers: Record<string, Producer<Deps>>;
  actions: Record<string, RegisteredAction<Deps>>;
  /**
   * Pure CEL functions, e.g. `{ signature: 'app_isBlank(string): bool', handler }`. Names match
   * `^[a-z][a-zA-Z0-9_]*$` (lower snake case or camelCase), conventionally `<prefix>_<name>`; a dotted
   * name is refused, and so are the name `belaykit`, a method on `BelayKit`, and a method on `dyn`
   * that would overlap a helper (its name and arguments), which belong to (or would also apply to)
   * BelayKit's own helpers (`belaykit.present`, in every rulebook).
   */
  functions?: RegisteredFunction[];
  /** Printed in the function reference's header. */
  version?: string;
  /** ws keys the agent sets when it initializes the working set. */
  initialKeys?: string[];
  /**
   * A JSON Schema per ws key, describing its value. At load, every field a rulebook reads is
   * followed through them, at any depth: from `ws.<key>`, from a `selectFirst` binding over
   * `ws.<key>` (its `items`), and from a CEL list macro's variable (`exists`, `all`, `exists_one`, `map`,
   * `filter`). A field no shape allows is a load error, and so is a string literal compared
   * (`==`, `!=`, `in [...]`) with a field whose shape lists its values (`enum`, `const`) but not
   * that one. Checking stops at an open object
   * (`additionalProperties` not `false`; `unevaluatedProperties` doesn't close one), a key without
   * a shape, or a non-local `$ref`; a tuple's `prefixItems` describe their own indexes. A shape for
   * a key nothing declares (`initialKeys`, `needs`, `writes`) is a registry problem. Shapes describe
   * keys for the check; working-set values aren't validated against them.
   */
  shapes?: Record<string, JsonSchema>;
}

/**
 * A rule as loaded. Each becomes a choice at run time, named by its `id`. Its expressions are as
 * written: a call to a macro shows the call, not its expansion.
 */
export interface Rule {
  /** The rule's own `id`, or `<section>#<n>` (n from 1). Explicit ids are unique within a section. */
  id: string;
  /** The rule's binding: `selectFirst: { <name>: <list expression> }`, or `null`. */
  selectFirst: { name: string; expression: string } | null;
  when: string;
  action: string;
  /** The rule's `then:` fields besides `action`. */
  params: Record<string, unknown>;
  why: string | null;
}

/** A section as loaded: when it applies (as written), what it gathers, how its rules are selected, and its rules. */
export interface Section {
  name: string;
  when: string;
  /** `needs` key → producer name. */
  needs: Record<string, string>;
  hitPolicy: 'FIRST' | 'ALL';
  rules: Rule[];
}

/** A rulebook run written as text: where it starts, what producers return, how it should end. */
export interface Fixture {
  /** Passed to `rulebook.initialize`. */
  initial: Record<string, unknown>;
  /** The value each `needs` key gets; producers aren't called. */
  produce?: Record<string, unknown>;
  /**
   * `fired` is compared with every iteration's `fired`, concatenated in order; `result` with the
   * run's result, by deep equality; `error` must be part of a failed run's error message.
   */
  expect: { status: 'completed' | 'no_match' | 'failed'; fired?: string[]; result?: unknown; error?: string };
}

/**
 * What `rulebook.runFixture` returns. `mismatches` is empty when `fixture.expect` holds. `result`
 * is present unless the run failed; `error` (the message) only when it failed.
 */
export interface FixtureRun {
  status: 'completed' | 'no_match' | 'failed';
  result?: unknown;
  error?: string;
  trace: TraceEntry[];
  workingSet: WorkingSet | null;
  mismatches: string[];
}

/**
 * The rule that decided an output (since 0.4): the last rule whose action gave it a new value (by
 * `Object.is`). A change inside the output's own value, such as a push into a list it holds, isn't a new value.
 */
export interface DecidedBy {
  /** The section's `name`. */
  section: string;
  /** The rule's `id`, or `<section>#<n>` for a rule without one: its choice's name in the trace. */
  rule: string;
  /** The iteration its action ran in, as the trace numbers them. */
  iteration: number;
}

/**
 * What `rulebook.decide` resolves to (since 0.2). `completed`: every declared output is present,
 * with its value in `outputs`, and the rule that decided it in `decidedBy` (since 0.4); an output no rule's action
 * set (something else wrote it, such as a producer beyond the key it gathers) fails the decision instead. Every decision has `evidence` (since
 * 0.4): the rulebook's `evidence:` keys present when the run ended, `null` included, absent ones left out; `{}` when
 * the rulebook declares none or the initializer failed. Outputs and evidence are copies (`structuredClone`) of plain
 * data; a value that can't be copied fails the decision, naming where it is: a class instance anywhere inside it,
 * built-ins such as `Error`, `URL` and `Buffer` included (a copy would drop its class), a function, a symbol, a
 * getter that throws. An evidence key that can't be copied is left out of `evidence`. What a copy loses without an
 * error (a symbol key, a key that isn't enumerable, an own key on a `Map`, `Set`, `Date`, `RegExp` or buffer, a
 * `RegExp`'s non-zero `lastIndex`, which a copy resets to 0) is let go, or with `onCopyLoss: 'fail'` fails the
 * decision too. The run's own message, if it had one, comes first. `no_match`:
 * nothing applied (no section claimed the working set, or one claimed and no rule held); `error` names the unset
 * outputs and the sections as the provider asked them (those before the one that claimed, that one, the rest not
 * reached). `failed`: something broke; `error` is the run's own message, then `decide`'s own problems (an output no
 * rule decided, a value that can't be copied), joined by `; `.
 */
export type Decision =
  | { status: 'completed'; outputs: Record<string, unknown>; decidedBy: Record<string, DecidedBy>; evidence: Record<string, unknown>; trace: TraceEntry[] }
  | { status: 'no_match' | 'failed'; error: string; evidence: Record<string, unknown>; trace: TraceEntry[] };

/**
 * How a rulebook given as text is read (since 0.3): its imports come from a folder (`baseDir`) or are given as text
 * (`imports`, since 0.4), not both (a `TypeError`). Text with `imports:` and neither is a load problem.
 */
export type RulebookTextOptions =
  | {
    /** The folder the rulebook's `imports` resolve from, as a file's own folder would be. */
    baseDir?: string;
    imports?: never;
  }
  | {
    baseDir?: never;
    /**
     * The macro files as text, by path (since 0.4), so nothing is read from disk. Paths are relative to the text they
     * come with (the rulebook, or for `checkMacros` the macro file), as its `imports:` writes them, and a file's own
     * imports resolve relative to it; `./a.yaml`, `x/../a.yaml` and `a.yaml/` are one file, and a path may climb
     * above it (`../shared/a.yaml`), as on disk. A path the map doesn't hold is a load problem, and so is an absolute
     * one. A plain object only (a `Map` is refused); an absolute key or one naming a folder (`.`, `..`), two keys
     * naming one file, or a value that isn't a string is a `TypeError`.
     */
    imports: Record<string, string>;
  };

/** A rulebook loaded and checked against a registry, which it keeps (a copy of its producers and actions). */
export class Rulebook {
  /** Made by `Rulebook.load` or `Rulebook.fromText` only; `new Rulebook()` throws. */
  private constructor();

  /**
   * Loads and checks a rulebook file (a relative `path` is resolved from the current directory):
   * the file's shape, then function names, unregistered producers and actions, a rule's params
   * against its action's `params`, CEL that fails to compile or calls an unknown function (an
   * unknown helper is named `belaykit.<name>`),
   * predicates whose type is known and isn't `bool`, rules sharing an explicit `id`, ws keys
   * nothing declares (`ws.x`, `ws["x"]`, and literal keys passed to a helper with `keyArgs`),
   * fields the registry's `shapes` don't allow, string literals compared with a field whose shape
   * lists other values (`enum`, `const`), `needs` keys named like an `Object.prototype`
   * property, `matches` patterns that aren't literals, don't compile, or may backtrack
   * exponentially, a CEL macro's variable named `belaykit`, a `belaykit.present` path that isn't a string
   * literal, has an empty key, or reads a field the known keys and shapes don't allow (checked as
   * field access is), templated params (a placeholder checked like a `when`, a known type that
   * can't become text, a stray or empty brace) and a brace in a param the action doesn't template,
   * and `selectFirst` bindings: a name that is `ws`, `belaykit`, a CEL reserved word or a registered
   * function's, a list expression whose type is known and isn't a list, and a binding used outside
   * its rule; a `FIRST` section with rules that neither ends in a rule with `when: "true"` (without
   * `selectFirst`) nor says `exhaustive: false` (a rule whose action has a `guard` isn't that catch-all), and
   * `exhaustive` where it means nothing; `outputs`
   * that no action writes or that gathering would set (a `needs` key, a producer's `writes`); `evidence` (since
   * 0.4) without `outputs`, or naming an output or a key nothing declares (a `needs` key, `initialKeys`, a
   * producer's or action's `writes`); the
   * `guard` of each action a rule names, checked like a `when` and reported once per action.
   * Registry problems (an unknown key in the registry or on a producer or action, a
   * function that won't register, a `params` or shape schema that won't compile, `templates` that
   * don't name plain-string params, a `guard` that isn't a string, a shape for an undeclared key) are listed too.
   *
   * Macros (since 0.3): `imports:` names macro files, relative to the rulebook, each `version: 1`,
   * `macros:` (a name → `{ params?, body, description? }`) and its own `imports:`. A rulebook calls
   * the macros of the files it imports itself, by name (`noErrorAndReady()`), in any `when`, a
   * `selectFirst` list or a templated param's placeholder (not a guard); a body calls those of its
   * own file and the files that file imports. Each call is expanded where it's written, so every
   * check above applies to the expansion; a problem a body has alone is reported once, on the macro
   * (`macro "x" (<file>): …`), and one that comes through a call's arguments at the call
   * (`… when, in macro "x": …`); a macro nothing calls is still checked for its name, params, the
   * names it reads and the macros it calls, but its body isn't compiled against the registry's
   * functions, keys and shapes (`Rulebook.checkMacros` checks a whole file against them). Refused
   * too: a missing or unreadable file; a cycle of imports or of calls; a macro name defined in two files, or that CEL, a registered function, `belaykit`, `cel` or a CEL reserved
   * word already has; a param whose name a `selectFirst` binding couldn't have, or that the body never
   * uses; a body that reads a name besides `ws`, its params and the variables it binds; a call with
   * the wrong number of arguments or written as a method; an argument that a variable the body binds
   * would capture; an expansion too large to check.
   *
   * Throws listing every problem, naming sections and rules (from 1); a `TypeError` when `path`
   * isn't a string.
   */
  static load(path: string, registry: Registry<any>): Rulebook;
  /**
   * The same, from text; imports resolve from `options.baseDir`, or come as text in `options.imports` (since 0.4).
   * A `TypeError` when `text` isn't a string, for an option it doesn't take, when `baseDir` isn't a string, for
   * both options at once, or for an `imports` map `RulebookTextOptions` refuses.
   */
  static fromText(text: string, registry: Registry<any>, options?: RulebookTextOptions): Rulebook;
  /**
   * Every problem `fromText` would throw for, one string each; `[]` when the text is clean.
   * YAML that doesn't parse is one problem (`YAML: …`). Never throws for a problem in the text; a
   * broken registry (one without `producers` or `actions`) still throws, as does text that isn't a
   * string or options `fromText` wouldn't take (a `TypeError`).
   */
  static check(text: string, registry: Registry<any>, options?: RulebookTextOptions): string[];
  /**
   * Every problem in a macro file's text, against `registry` (since 0.3); `[]` when it's clean. Each macro in
   * it is checked as a rulebook calling it would check it, whether or not one does: its name, params and
   * calls, cycles, its body against the registry's functions, and the keys it reads against those the
   * registry names (`initialKeys`, any `writes`, the keys of `shapes`: a file has no `needs`) and their shapes.
   * A param stands for any value, so fields read through one are checked where the macro is called. Without
   * `options.baseDir` or `options.imports` its imports are a problem and aren't read; its own macros are still
   * checked. Imports resolve from `options.baseDir`, or come from `options.imports` (paths relative to this file,
   * since 0.4), and an imported file's macros are checked as far as this
   * file's call them. `options.path` (since 0.4) says where this file sits, relative to `baseDir` or to the
   * imports' paths: its imports then resolve from its own folder, and an import that leads back to it is a cycle
   * (without it, the file is read again and its macros are "defined in both"); a `TypeError` without `baseDir` or
   * `imports`, for a path that isn't a file's, or for one whose `imports` entry holds other text. The file's own
   * problems carry no file name (`macro "x": …`); the registry's own problems are listed too. Given a rulebook, it
   * says so, and to use `check`. Throws as `check` does.
   */
  static checkMacros(text: string, registry: Registry<any>, options?: RulebookTextOptions & { path?: string }): string[];

  /** The sections as loaded (a copy). */
  readonly sections: Section[];
  /** Every `needs` key, across sections (a copy). */
  readonly declaredKeys: string[];

  /**
   * What this rulebook may call, as Markdown (since 0.3): `describeFunctions(registry)` for its registry, then the
   * macros of the files it imports itself, by name, each with its call form, file, description and body as
   * written. A rulebook without imports gives exactly `describeFunctions(registry)`.
   */
  describeFunctions(): string;

  /**
   * The agent's initial working set, as a copy with nothing added: each `needs` key is absent until
   * its section gathers it. Throws a `TypeError` naming the key when `initial` already holds a
   * declared `needs` key (`null` included), since it would count as gathered and its producer never run.
   */
  initialize<Initial extends Record<string, unknown>>(initial: Initial): Initial & WorkingSet;

  /**
   * The choice provider for one run's deps, which reach producers and actions. Returns `null` when
   * no section claims the working set, so it composes with code providers through `chain`. Each
   * rule becomes a choice named by its `id`, carrying its `why`. A `selectFirst` rule matches on
   * the first item, in list order, for which its `when` holds; its action receives `selected`,
   * and its trace entry `detail: { <name>: <index> }`. A rule whose action has a `guard` is first
   * checked against it: a false guard doesn't match (`detail: { guard: false }`), without evaluating
   * the rule's `when` or selection. A `when` or guard that evaluates to anything but a
   * boolean, or a `selectFirst` expression that evaluates to anything but a list, throws, so the
   * run ends `failed` naming the section (and rule).
   */
  provider(deps?: unknown): ChoiceProvider<WorkingSet>;

  /**
   * Has a `needs` key gathered again: deletes it from the working set, so its section gathers it
   * again. Called from an action (actions are the working set's only writers).
   * Throws a `TypeError` for a key this rulebook doesn't declare.
   */
  regather(workingSet: WorkingSet, key: string): void;

  /**
   * A run on the core's `Agent`, with producers replaced by `fixture.produce` and the registry's
   * real actions given `deps`, and the agent's finalizer if given. A `needs` key the run asks for
   * and `produce` lacks fails the run, and is named as a mismatch. The run uses the default trace.
   * Rejects with a `TypeError` for an option it doesn't take, or without `fixture` or `finishChecker`.
   */
  runFixture(options: {
    fixture: Fixture;
    deps?: unknown;
    finishChecker: FinishChecker<WorkingSet>;
    finalizer?: Finalizer<WorkingSet, unknown>;
    maxIterations?: number;
  }): Promise<FixtureRun>;

  /**
   * The rulebook as a decision function: a run on the core's `Agent`, from `initialize(initial)`,
   * until every output the rulebook declares (`outputs:`) is present. Always resolves; an output
   * or `needs` key already present in `initial` fails the run, naming it. `deps` reach producers
   * and actions; `maxIterations` bounds the run (default 25). `onCopyLoss` (since 0.4) says what happens to a key
   * a copy of an output or evidence value leaves out without an error: `'drop'` (the default) leaves it out,
   * `'fail'` fails the decision, naming it. The trace is the default one.
   * Rejects with a `TypeError` when the rulebook declares no outputs, for an option it doesn't take, or for
   * an option's bad value (`maxIterations: 0`, `onCopyLoss: 'strict'`).
   */
  decide(initial?: Record<string, unknown>, options?: { deps?: unknown; maxIterations?: number; onCopyLoss?: 'drop' | 'fail' }): Promise<Decision>;
}

/**
 * Reads a YAML fixture (a relative `path` is resolved from the current directory). Throws naming
 * the file and each problem when it's malformed: YAML that doesn't parse (`<path>: YAML: …`) or a
 * fixture of the wrong shape (`<path>: expect.status: must be one of …`).
 */
export function loadFixture(path: string): Fixture;

/**
 * What a rulebook may call, as Markdown: BelayKit's helpers (`belaykit.*`) first, then the
 * registry's functions, each with its signature, description and parameters, a note for
 * `keyArgs`, and `version` in the header when set. CEL's built-in functions are left out. Throws
 * when a function fails to register.
 */
export function describeFunctions(registry: Registry<any>): string;

/**
 * This package's version, as in its `package.json`. It names the release, not the installed files:
 * a locally edited copy reports the same version.
 */
export declare const version: string;

/** The rulebook `version:` values this package reads (today `[1]`); any other is a load error. */
export declare const schemaVersions: readonly number[];
