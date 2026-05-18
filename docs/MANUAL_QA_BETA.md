# ContactBridge Manual QA Checklist

- [ ] First-run dashboard shows the local-first beta status and healthy backend/database cards
- [ ] Source setup page lists supported connectors and keeps hosted-mode warnings visible
- [ ] Demo fixture sync completes with `npm run demo` data and does not require real provider tokens
- [ ] Manual extension capture stores one supported public profile from the unpacked extension
- [ ] Review queue shows the captured/imported candidate
- [ ] Candidate approve action moves an approved contact into exports
- [ ] Candidate ignore action removes one candidate from the active review flow
- [ ] Candidate merge action combines duplicate evidence into one approved contact
- [ ] CSV export downloads and includes only approved contacts
- [ ] JSON export downloads and includes only approved contacts
- [ ] VCF export downloads and includes only approved contacts
- [ ] Backup downloads successfully in local/test mode
- [ ] Restore accepts a valid backup and reloads the saved data set
- [ ] Reset clears local data only after explicit confirmation
- [ ] Hosted-mode warning remains visible in docs/UI where hosted deployment is mentioned
- [ ] LinkedIn wording stays restricted to manual capture and approved partner-access-only API sync
