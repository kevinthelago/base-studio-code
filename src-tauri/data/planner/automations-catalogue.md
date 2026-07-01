# Automations Catalogue

Assign an automation to this project with the bundled `bsc` CLI:
`bsc plan automations add "<name>" --command "<cmd>" --schedule "0 9 * * 1-5" --description "<text>"`

`--schedule` is a cron expression (omit for one-shot commands); `bsc plan automations list` shows the set.
