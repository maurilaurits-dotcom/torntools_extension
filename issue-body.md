For the past month I've used a personal Android app that watches the foreign-stock feeds, learns how long each item stays empty, and tells me when to fly so I land as it restocks. I've ported its logic into TornTools as a working branch, and before opening a PR I'd like to know whether you want it, and in what shape.

**Report, with a live demo board and the evidence:** https://maurilaurits-dotcom.github.io/torntools_extension/travel-radar/
**Branch:** https://github.com/maurilaurits-dotcom/torntools_extension/tree/feature/travel-radar ([compare with master](https://github.com/Mephiles/torntools_extension/compare/master...maurilaurits-dotcom:torntools_extension:feature/travel-radar))

What it adds, all off by default:
- **Leave-now notification** for items you watch: fly by this time to land at the early edge of the predicted restock window. It accounts for your ticket type.
- **Restocked notification** when a watched item comes back and should still be there when you land.
- **Travel Radar panel** on the Travel Agency page: each predictable item with its plan, and a bell to watch it.

How it fits: one `fetchTravelData()` read every 5 minutes while it's on, through the user's own service priorities. No new Torn API calls: it reads the existing userdata for status and ticket type. The logic is pure (`features/travel-radar/radar-core.ts`, 36 unit tests), and existing files change by 38 lines. Replayed over 48 hours of YATA history, landing at the predicted window found stock in 98–100% of restock cycles. On a live overnight recording, at the extension's 5-minute pace, it found stock on all 18 restocks it timed, after a median wait of 2.3 minutes; Prometheus' own `nextRestock` for the same restocks was off by a median 21 minutes.

Questions for you:
1. Is a 5-minute background read acceptable for users who turn it on? Reading every minute confirms far more of the fast items' restocks, but it's five times the load on the feeds.
2. A separate panel, or columns in the Travel Table?
3. Is it OK to ship seeds for six items so it predicts from the first check? And one PR, or the core and background first, then the panel?

You merged my #1086 in July; I'll follow CONTRIBUTING and the PR template.
