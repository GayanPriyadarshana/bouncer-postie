Mochi - email & website checker

1. Install Node.js 18 or newer (https://nodejs.org) if you don't have it.
2. Copy .env.example to .env and paste your Bouncer API key into it.
   (Skip this to try the app in demo mode with sample answers.)
3. Double-click start.bat (or run: node server.js)
4. Your browser opens http://localhost:3000

Bulk: switch to "A whole list", drop in a CSV (any columns - Mochi finds the
email column), then download the same file with bouncer_* result columns added.

Every email gets one of three answers: Safe, Bounce Risk or Dead (never "unknown").
If Bouncer can't tell, Mochi asks again up to 3 times with more patience (10s, 20s, 30s).
If it still can't tell, Mochi checks the domain's mail records itself: no mail server = Dead,
otherwise Bounce Risk. The CSV keeps Bouncer's original answer in bouncer_raw_status.
Reopening an older list from History re-checks its old "unknown" rows when you click Continue.

Job changes for Dead emails (Apollo)
------------------------------------
Paste your Apollo API key into .env as APOLLO_API_KEY=... (without it, job checks show sample answers).
In the results table every Dead email has a "Check job" button. Tick several (or the box in the
header to select all dead in the current view) and click "Check selected", or "Check all N dead".
Mochi asks before spending credits: up to 1 Apollo credit per person found, none when nobody is found.
If your CSV has First Name / Last Name / Company / LinkedIn columns, they're sent too for better matches.
Answers: Changed job (new company / title / new email), New email (same company), Still there,
No current job, Not in Apollo. Results are saved to History and added to the CSV as apollo_* columns.

Demo mode tips: try someone@gmial.com, info@acme.com, bad@acme.com, maybe@acme.com
Your API key stays on your computer - the browser never sees it.

Websites section
----------------
Click "Websites" at the top to check if sites are still alive - one at a time or a
whole CSV / text file (one site per line). For each site Mochi follows every redirect
and gives a verdict:
  OK, REDIRECT_SAME_SITE (fine), REDIRECT_OTHER_DOMAIN (review), PARKED_OR_FOR_SALE,
  PLACEHOLDER, HTTP_ERROR, DEAD
Broken sites are retried as https://, https://www., http:// and http://www. (shown as
"Fix found" / working_variant), and still-broken ones get the latest Wayback Machine
snapshot. No API key or credits needed - checks run from your own computer.

LinkedIn + results table
------------------------
For every working site Mochi looks for the company's LinkedIn page (homepage first,
then /contact and /about). It's shown in the results and saved in the CSV as
linkedin_url and linkedin_found_on. The results table can be searched, filtered
(verdict, fix found, has / no LinkedIn, needs fixing), sorted by clicking a column
header, and paged (10/25/50/100 rows). "Download this view" saves just the filtered rows.

History (saved results)
-----------------------
Every run is saved automatically - lists as they progress (every couple of seconds),
and single checks grouped into one entry per day. Click "History" at the top to
reopen results, continue an unfinished list (even after closing the browser or
restarting), download the CSV again, or delete a run.
Everything is stored in the "data" folder next to the app. Back up or delete that
folder as you like.

Salesforce section (re-verify old Lead / Contact emails)
--------------------------------------------------------
Add to .env:
  SF_CLIENT_ID=<Consumer Key>
  SF_CLIENT_SECRET=<Consumer Secret>
  SF_DOMAIN=https://yourcompany.my.salesforce.com      (Setup -> My Domain shows this)
Restart Mochi, click "Salesforce" at the top.

Connecting with the keys alone (no login) uses Salesforce's Client Credentials Flow. An admin
must switch it on once: Setup -> App Manager -> your app -> Edit -> tick "Enable Client
Credentials Flow"; then Manage -> Edit Policies -> Client Credentials Flow -> Run As = a user
that can read/edit Leads and Contacts. If that isn't possible, click "Sign in with Salesforce"
instead (the app's Callback URL must include http://localhost:3000/api/sf/callback).

Fetch Leads / Fetch Contacts finds records with an email whose Email_Verified_Date__c is older
than the months you choose (default 8), plus never-verified ones (converted Leads are skipped).
Use "Max records" for a small test first. "Verify" checks each unique email with Bouncer.
Each result is written as Safe, Bounce Risk or Dead:
"Update ... in Salesforce" writes only that status value - Salesforce updates
Email_Verified_Date__c itself. (Add SF_WRITE_DATE=1 to .env if Mochi should write the date too.)
Failed updates are listed with Salesforce's reason and can be retried. Runs are saved to History.

Updating Salesforce from the Emails section
-------------------------------------------
After a single check, or when a list has finished, click "Update Salesforce". Mochi finds the
Leads (not converted) and Contacts that use those emails, shows what it will write, and on
"Update" writes the new Email_Verification_Status__c using the same
values (Safe / Bounce Risk / Dead). Emails Bouncer couldn't check are never written.
