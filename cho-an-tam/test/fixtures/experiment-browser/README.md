# Archived browser experiment fixtures

These files preserve the former S1/S2 collection-page code for isolated regression checks and reproducibility. They are outside public/ and are not copied into the production Docker image. Do not publish or mount this directory on a user-facing origin.

The production S1/S2 preparation URLs have been retired. A current session's access token, and the S2 packet's unused financial grant, must not be exposed through a general-purpose copy button on the public application. Client-side consent, origin checks, a hidden link or noindex do not restrict this capability to approved test accounts.

The application denies the entire /experiments namespace, including encoded/case/path variants, before parsing bodies, CORS preflight handling and static-file serving. There is deliberately no frontend flag or production switch that re-enables these tools. A future collector needs a separately reviewed access boundary and dedicated test accounts; copying these fixtures back into public/ is not an enablement procedure.

Existing experiment screenshots remain evidence of the controlled run that produced them. Removing the collector does not change the normal login, Passkey or Escrow authorization APIs. Previously exported credentials are not revoked by deleting a page; log out the test account through the normal application to revoke that session.
