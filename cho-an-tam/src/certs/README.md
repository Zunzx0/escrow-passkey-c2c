# Public database CA

`supabase-prod-ca-2021.crt` is the public Supabase Root 2021 CA certificate, downloaded from the project's **Database → Settings → SSL configuration → Download certificate** on 30 October 2026.

Official download: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

SHA-256 certificate fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`. Valid until 26 April 2031. This file contains no private key or database credential.

`lib/pgTls.js` adds this CA to Node's public roots and requires both certificate-chain and hostname verification. Invalid or expired server certificates stop the connection. Renew this public certificate from the authenticated Supabase dashboard when the provider rotates its CA; never resolve certificate errors with `rejectUnauthorized: false`.

SSL options in a PostgreSQL URL are removed before `pg` parses it, because they otherwise replace the explicit `ssl` object: https://node-postgres.com/features/ssl#usage-with-connectionstring

Plain connections are permitted only when explicitly requested for loopback PostgreSQL outside production. Test with `node --test test/pg-tls.test.js`; its two negative wire-level checks create disposable certificates with OpenSSL and never contact production.
