# Read logs you already have

Nine small logs of the same shop, each in the shape a real source writes it: an app's JSON lines, pino, a hosting
platform's CLI output and log drain, Railway, the system journal, a web server's access log, a plain text log and a
container's output. In each one the same bug is planted: `/report` fails five times, and what it logs holds the key it
called its upstream with. The data is made up.

```bash
npm install
npx codmir-logs logs/app.log
```

```
JUDGED    HITS  ID        TITLE                                                         FIRST SEEN           LAST SEEN
new          5  3b39957f  report failed for user #: upstream rejected api_key=[secret]  2026-11-24 10:01:00  2026-11-24 10:01:40
read 8 lines (662 B): 7 records, 0 requests, 1 skipped. 1 finding: 1 new.
```

Any other file in `logs/` gives the same bug as one finding (a request log gives `GET /report answers 500`, judged
`alarm`). The format is found per line; `--format journald` (and the others) says it outright. The key is masked, and
nothing leaves this machine: there is no `--cloud`, so there is no network.

```bash
cat logs/journal.jsonl | npx codmir-logs                 # standard input
npx codmir-logs logs/app.log --state state.json          # a second run knows what is new
npx codmir-logs logs/app.log --fail-on new || echo "a new finding"   # exit 1 for a CI step
```

`npm run smoke` runs the command on every file with the network refused (`no-network.mjs`) and checks the findings.
