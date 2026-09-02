# Portal UX Advisor — findings of 2026-09-02

Produced by `node portal/ux-advisor.mjs` (Assistant Unit 9): a MEASUREMENT
sweep of the signed-in portal at desktop (1200) / tablet (820) / iPhone (390),
over 11 screens with a seeded case, day, activity and invoice. Every finding
below is a measured fact with its evidence; recommendations are suggestions
for a person. **Nothing here changes or deploys source automatically.**

**51 findings:** 1 high, 11 medium, 33 low, 6 info.

Calibration notes, so the numbers read honestly: an element under a fixed
overlay (the Assistant dock over the page, rows scrolled beneath the ask bar)
is occlusion by design and is NOT counted as overlap — only two controls both
hittable at their own centers are. The 44px tap floor is the portal's own
phone rule, so under-floor controls are HIGH at iPhone and MEDIUM at tablet
(where the desktop-density layout is intentional). Multi-line CARD buttons
(the rate-sheet cards, the surveillance launcher) wrap by design and appear
as LOW observations, not defects.

## HIGH (1)

| Page | Width | Class | Observation | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Case overview | iPhone | tap-target | 6 control(s) under the 44px tap floor | Assign: 38×12px; ○ Activity 0 entries: 272×35px; ○ Report None: 272×35px; ○ Photos 0: 272×35px; ○ Build Not started: 272×35px; ○ Invoice Not created: 272×34px | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |

## MEDIUM (11)

| Page | Width | Class | Observation | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Case overview | iPhone | overlap | "Menu" and "← Back to Cases" overlap 46×44px | Measured at Case overview @ iPhone (390px); both are interactive and neither contains the other — seen on 3 screens (Case overview, Case activity, Case billing) | Separate the two controls or stack them at this width. |
| Case overview | tablet | overlap | "Menu" and "← Back to Cases" overlap 46×22px | Measured at Case overview @ tablet (820px); both are interactive and neither contains the other — seen on 3 screens (Case overview, Case activity, Case billing) | Separate the two controls or stack them at this width. |
| Case overview | tablet | tap-target | 10 control(s) under the 44px tap floor | Sign out: 80×35px; ← Back to Cases: 146×29px; Start one: 97×37px; 0 files on this case →: 181×37px; Open the activity log →: 199×37px; Record payment: 147×35px; Assign: 38×12px; ○ Activity 0 entries: 311×35px; ○ Report None: 311×35px; ○ Photos 0: 311×35px — seen on 2 screens (Case overview, Case billing) | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |
| Cases | tablet | tap-target | 7 control(s) under the 44px tap floor | Sign out: 80×35px; Search cases: 280×41px; All: 49×34px; Open: 68×34px; Completed: 108×34px; Archived: 93×34px; Deleted: 86×34px | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |
| Dashboard | tablet | overlap | "Off Dropbox Not set up on the Worker yet" and "Open the API Assistant (Beta)" overlap 99×46px | Measured at Dashboard @ tablet (820px); both are interactive and neither contains the other | Separate the two controls or stack them at this width. |
| Dashboard | tablet | tap-target | 6 control(s) under the 44px tap floor | Sign out: 80×35px; All 3: 62×34px; Intakes 2: 96×34px; Storage 1: 100×34px; View all cases →: 147×37px; Reports & Packages →: 192×37px | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |
| Leads & Intakes | tablet | tap-target | 4 control(s) under the 44px tap floor | Sign out: 80×35px; + Intake a client: 147×35px; Lead Rate sheet sent Intake sent Intake : 159×43px; Lead Rate sheet sent Intake sent Intake : 167×43px — seen on 2 screens (Leads & Intakes, Billing) | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |
| Rate Sheets | iPhone | overlap | "Private Client — $1,500 Retainer Private" and "Open the API Assistant (Beta)" overlap 76×48px | Measured at Rate Sheets @ iPhone (390px); both are interactive and neither contains the other | Separate the two controls or stack them at this width. |
| Rate Sheets | tablet | tap-target | 5 control(s) under the 44px tap floor | Sign out: 80×35px; Send private intake: 173×37px; Send insurance intake: 193×37px; Send legal intake: 156×37px; Send payment options: 194×37px | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |
| Search | tablet | tap-target | 1 control(s) under the 44px tap floor | Sign out: 80×35px | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |
| Settings | tablet | tap-target | 3 control(s) under the 44px tap floor | Sign out: 80×35px; Refresh: 85×37px; Add a test case: 142×37px — seen on 2 screens (Settings, Case activity) | Raise to the portal's own 44px floor (min-height/min-width) at touch widths. |

## LOW (33)

| Page | Width | Class | Observation | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Case overview | desktop | wrapped-control | Button "Active Surveillance Mode The field view:" wraps to ~82px tall | Height ≥ 2.2 line-heights at Case overview @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Case overview | iPhone | wrapped-control | Button "Active Surveillance Mode The field view:" wraps to ~141px tall | Height ≥ 2.2 line-heights at Case overview @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Case overview | iPhone | wrapped-control | Button "✎ Activity" wraps to ~53px tall | Height ≥ 2.2 line-heights at Case overview @ iPhone (390px) — seen on 3 screens (Case overview, Case activity, Case billing) | Shorten the label or let the control take a wider track. |
| Case overview | iPhone | wrapped-control | Button "📝 Summary" wraps to ~53px tall | Height ≥ 2.2 line-heights at Case overview @ iPhone (390px) — seen on 3 screens (Case overview, Case activity, Case billing) | Shorten the label or let the control take a wider track. |
| Case overview | iPhone | wrapped-control | Button "➕ Add" wraps to ~53px tall | Height ≥ 2.2 line-heights at Case overview @ iPhone (390px) — seen on 3 screens (Case overview, Case activity, Case billing) | Shorten the label or let the control take a wider track. |
| Case overview | iPhone | wrapped-control | Button "📷 Evidence" wraps to ~53px tall | Height ≥ 2.2 line-heights at Case overview @ iPhone (390px) — seen on 3 screens (Case overview, Case activity, Case billing) | Shorten the label or let the control take a wider track. |
| Case overview | iPhone | wrapped-control | Button "⋯ More" wraps to ~53px tall | Height ≥ 2.2 line-heights at Case overview @ iPhone (390px) — seen on 3 screens (Case overview, Case activity, Case billing) | Shorten the label or let the control take a wider track. |
| Case overview | tablet | wrapped-control | Button "Active Surveillance Mode The field view:" wraps to ~82px tall | Height ≥ 2.2 line-heights at Case overview @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Dashboard | desktop | wrapped-control | Button "○ Activity 0 entries" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Dashboard | desktop | wrapped-control | Button "○ Report None" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Dashboard | desktop | wrapped-control | Button "○ Photos 0" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Dashboard | desktop | wrapped-control | Button "○ Build Not started" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Dashboard | desktop | wrapped-control | Button "○ Invoice Not created" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Dashboard | iPhone | wrapped-control | Button "📪 Carrier assignment received UX-CASE-2" wraps to ~96px tall | Height ≥ 2.2 line-heights at Dashboard @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Dashboard | iPhone | wrapped-control | Button "📪 Intake received UX-CASE-1 Sep 2, 2026" wraps to ~74px tall | Height ≥ 2.2 line-heights at Dashboard @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Dashboard | iPhone | wrapped-control | Button "○ Activity 0 entries" wraps to ~60px tall | Height ≥ 2.2 line-heights at Dashboard @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Dashboard | iPhone | wrapped-control | Button "○ Report None" wraps to ~60px tall | Height ≥ 2.2 line-heights at Dashboard @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Dashboard | iPhone | wrapped-control | Button "○ Photos 0" wraps to ~60px tall | Height ≥ 2.2 line-heights at Dashboard @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Dashboard | iPhone | wrapped-control | Button "○ Build Not started" wraps to ~60px tall | Height ≥ 2.2 line-heights at Dashboard @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Dashboard | tablet | wrapped-control | Button "○ Activity 0 entries" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Dashboard | tablet | wrapped-control | Button "○ Report None" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Dashboard | tablet | wrapped-control | Button "○ Photos 0" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Dashboard | tablet | wrapped-control | Button "○ Build Not started" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Dashboard | tablet | wrapped-control | Button "○ Invoice Not created" wraps to ~49px tall | Height ≥ 2.2 line-heights at Dashboard @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | desktop | wrapped-control | Button "Private Client — $1,500 Retainer Private" wraps to ~278px tall | Height ≥ 2.2 line-heights at Rate Sheets @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | desktop | wrapped-control | Button "Insurance Assignment Rates For carriers," wraps to ~278px tall | Height ≥ 2.2 line-heights at Rate Sheets @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | desktop | wrapped-control | Button "Legal / Law Firm — $1,500 Retainer Law f" wraps to ~278px tall | Height ≥ 2.2 line-heights at Rate Sheets @ desktop (1200px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | iPhone | wrapped-control | Button "Private Client — $1,500 Retainer Private" wraps to ~256px tall | Height ≥ 2.2 line-heights at Rate Sheets @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | iPhone | wrapped-control | Button "Insurance Assignment Rates For carriers," wraps to ~251px tall | Height ≥ 2.2 line-heights at Rate Sheets @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | iPhone | wrapped-control | Button "Legal / Law Firm — $1,500 Retainer Law f" wraps to ~236px tall | Height ≥ 2.2 line-heights at Rate Sheets @ iPhone (390px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | tablet | wrapped-control | Button "Private Client — $1,500 Retainer Private" wraps to ~229px tall | Height ≥ 2.2 line-heights at Rate Sheets @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | tablet | wrapped-control | Button "Insurance Assignment Rates For carriers," wraps to ~229px tall | Height ≥ 2.2 line-heights at Rate Sheets @ tablet (820px) | Shorten the label or let the control take a wider track. |
| Rate Sheets | tablet | wrapped-control | Button "Legal / Law Firm — $1,500 Retainer Law f" wraps to ~213px tall | Height ≥ 2.2 line-heights at Rate Sheets @ tablet (820px) | Shorten the label or let the control take a wider track. |

## INFO (6)

| Page | Width | Class | Observation | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Dashboard | desktop | terminology | Both "Package" (5×) and "Build" (2×) are on screen | Counted in body text at Dashboard @ desktop (1200px) | If they name the same thing here, pick the label the owner uses and keep the other for the record. |
| Dashboard | iPhone | terminology | Both "Package" (4×) and "Build" (2×) are on screen | Counted in body text at Dashboard @ iPhone (390px) | If they name the same thing here, pick the label the owner uses and keep the other for the record. |
| Dashboard | tablet | terminology | Both "Package" (4×) and "Build" (2×) are on screen | Counted in body text at Dashboard @ tablet (820px) | If they name the same thing here, pick the label the owner uses and keep the other for the record. |
| Leads & Intakes | desktop | terminology | Both "Intake" (9×) and "Lead" (4×) are on screen | Counted in body text at Leads & Intakes @ desktop (1200px) | If they name the same thing here, pick the label the owner uses and keep the other for the record. |
| Leads & Intakes | iPhone | terminology | Both "Intake" (7×) and "Lead" (4×) are on screen | Counted in body text at Leads & Intakes @ iPhone (390px) | If they name the same thing here, pick the label the owner uses and keep the other for the record. |
| Leads & Intakes | tablet | terminology | Both "Intake" (7×) and "Lead" (4×) are on screen | Counted in body text at Leads & Intakes @ tablet (820px) | If they name the same thing here, pick the label the owner uses and keep the other for the record. |

## Needs human judgment (deliberately not machine-decided)

- confusing hierarchy — needs a person (or an owner-approved provider) to judge
- irrelevant information per screen — needs a person to judge against real workflows
- click-depth of high-frequency actions — needs the owner's own frequency ranking first

Status of every finding above is `open`; update `status` in
`case-portal/UX-FINDINGS.json` as items are addressed or accepted as-is,
and re-run the sweep to refresh `last_seen`.
