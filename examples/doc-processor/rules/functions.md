# Rulebook functions

Functions named `belaykit.*` are BelayKit's own helpers, in every rulebook; the others are the registry's.

## belaykit.present

`belaykit.present(dyn, dyn): bool`

True when every key on the path exists and the last value isn't null. A missing key, or a null on the way, is false; a step into a value that isn't a map, and an empty path or segment, are errors. `has()` is true for a key holding null.

| Parameter | Type | Description |
| --- | --- | --- |
| container | dyn | A map to read from: ws, a selectFirst binding or a macro variable |
| path | dyn | Keys joined by dots, such as "facts.recurrence": a string literal, checked at load like the fields it reads |

## doc_waiting

`doc_waiting(map<dyn, dyn>, list<dyn>): bool`

True when the snippet is the one waiting for review: the first classified snippet not yet reviewed.

| Parameter | Type | Description |
| --- | --- | --- |
| snippet | map<dyn, dyn> | A snippet from the working set |
| snippets | list<dyn> | All of the run's snippets |

## doc_outside

`doc_outside(list<dyn>, list<dyn>): bool`

True when any item of the first list is missing from the second: a topic or theme outside the map.

| Parameter | Type | Description |
| --- | --- | --- |
| items | list<dyn> | What the classifier returned |
| known | list<dyn> | What the map holds |
