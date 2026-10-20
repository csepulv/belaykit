# Rulebook functions

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
