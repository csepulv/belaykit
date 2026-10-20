import type { ChoiceProvider, Finalizer, FinishChecker, TraceEntry } from '@belaykit/core';

/**
 * A working set as a rulebook sees it: `ws` in CEL. `gathered` is the plugin's own: the `needs`
 * keys produced so far. Every other key, a terminal field included, is the agent's.
 */
export type WorkingSet = Record<string, unknown> & { gathered: string[] };

/**
 * Fills one `needs` key. Returns the key's value; `null` is a valid answer
 * ("looked, found nothing") and still counts as gathered.
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
  /** The rule's literal `then:` fields, besides `action`. Read-only: they are frozen at load. */
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
   * name is refused.
   */
  functions?: RegisteredFunction[];
  /** Printed in the function reference's header. */
  version?: string;
  /** ws keys the agent sets when it initializes the working set. */
  initialKeys?: string[];
  /**
   * A JSON Schema per ws key, describing its value. At load, every field a rulebook reads is
   * followed through them, at any depth: from `ws.<key>`, from a `selectFirst` binding over
   * `ws.<key>` (its `items`), and from a macro's variable (`exists`, `all`, `exists_one`, `map`,
   * `filter`). A field no shape allows is a load error; checking stops at an open object
   * (`additionalProperties` not `false`; `unevaluatedProperties` doesn't close one), a key without
   * a shape, or a non-local `$ref`; a tuple's `prefixItems` describe their own indexes. A shape for
   * a key nothing declares (`initialKeys`, `needs`, `writes`) is a registry problem. Shapes describe
   * keys for the check; working-set values aren't validated against them.
   */
  shapes?: Record<string, JsonSchema>;
}

/** A rule as loaded. Each becomes a choice at run time, named by its `id`. */
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

/** A section as loaded: when it applies, what it gathers, how its rules are selected, and its rules. */
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

/** A rulebook loaded and checked against a registry, which it keeps (a copy of its producers and actions). */
export class Rulebook {
  /** Made by `Rulebook.load` or `Rulebook.fromText` only; `new Rulebook()` throws. */
  private constructor();

  /**
   * Loads and checks a rulebook file (a relative `path` is resolved from the current directory):
   * the file's shape, then function names, unregistered producers and actions, a rule's params
   * against its action's `params`, CEL that fails to compile or calls an unknown function,
   * predicates whose type is known and isn't `bool`, rules sharing an explicit `id`, ws keys
   * nothing declares (`ws.x`, `ws["x"]`, and literal keys passed to a helper with `keyArgs`),
   * fields the registry's `shapes` don't allow, `needs` keys named like an `Object.prototype`
   * property, `matches` patterns that aren't literals, don't compile, or may backtrack
   * exponentially, and `selectFirst` bindings: a name that is `ws`, a CEL reserved word or a
   * registered function's, a list expression whose type is known and isn't a list, and a binding
   * used outside its rule. Registry problems (an unknown registry key, a function that won't
   * register, a `params` or shape schema that won't compile, a shape for an undeclared key) are
   * listed too. Throws listing every problem, naming sections and rules (from 1); a `TypeError`
   * when `path` isn't a string.
   */
  static load(path: string, registry: Registry<any>): Rulebook;
  /** The same, from text; a `TypeError` when `text` isn't a string. */
  static fromText(text: string, registry: Registry<any>): Rulebook;
  /**
   * Every problem `fromText` would throw for, one string each; `[]` when the text is clean.
   * YAML that doesn't parse is one problem (`YAML: …`). Never throws for a problem in the text; a
   * broken registry (one without `producers` or `actions`) still throws, as does text that isn't a
   * string (a `TypeError`).
   */
  static check(text: string, registry: Registry<any>): string[];

  /** The sections as loaded (a copy). */
  readonly sections: Section[];
  /** Every `needs` key, across sections (a copy). */
  readonly declaredKeys: string[];

  /** The agent's initial keys, plus every declared `needs` key as null; nothing is gathered yet. */
  initialize<Initial extends Record<string, unknown>>(initial: Initial): Initial & WorkingSet;

  /**
   * The choice provider for one run's deps, which reach producers and actions. Returns `null` when
   * no section claims the working set, so it composes with code providers through `chain`. Each
   * rule becomes a choice named by its `id`, carrying its `why`. A `selectFirst` rule matches on
   * the first item, in list order, for which its `when` holds; its action receives `selected`,
   * and its trace entry `detail: { <name>: <index> }`. A `when` that evaluates to anything but a
   * boolean, or a `selectFirst` expression that evaluates to anything but a list, throws, so the
   * run ends `failed` naming the section (and rule).
   */
  provider(deps?: unknown): ChoiceProvider<WorkingSet>;

  /**
   * Has a `needs` key gathered again: sets it back to null and removes it from `gathered`, so its
   * section gathers it again. Called from an action (actions are the working set's only writers).
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
}

/**
 * Reads a YAML fixture (a relative `path` is resolved from the current directory). Throws naming
 * the file and each problem when it's malformed: YAML that doesn't parse (`<path>: YAML: …`) or a
 * fixture of the wrong shape (`<path>: expect.status: must be one of …`).
 */
export function loadFixture(path: string): Fixture;

/**
 * The registry's functions as Markdown: each signature, description and parameters, a note for
 * `keyArgs`, and `version` in the header when set. CEL's built-in functions are left out. Throws
 * when a function fails to register.
 */
export function describeFunctions(registry: Registry<any>): string;
