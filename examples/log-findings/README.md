# Log findings

A tiny server with a planted bug: `/report` answers 500 and logs the key it was calling its upstream with. A loop calls
the server, and `@codmir/sdk/logs` groups what the app logged into one finding, with the key masked.

```bash
npm install
npm start
```

```
served 10 requests, 5 failed
findings: 1
  [new] 5 hits: report failed for user #: upstream rejected api_key=[secret]
  sample: report failed for user 4821: upstream rejected api_key=[secret]
```

Local mode: no account, no key, no network beyond the loop calling its own server on `127.0.0.1`. To send the findings to
a Codmir project too, add `cloud: { apiKey: "osk_..." }` to `createLogMonitor`.
