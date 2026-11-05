# New Vecteezy 3.0 — project notes

## Terminology
- **Action Card** — general term for the card that appears inside an AI Magic bot response summarizing an action the user performed on the site.
- **Search Action Card** — text-only pill: white fully-rounded card with an 18px orange search icon and the quoted query in bold (17px/700); no images. Documented in `Style Guide - Action Cards.dc.html`.
- **Generate Search Card** (formerly Generate Action Card) — white card at 14px radius (matches chat bubble): header row with an 18px orange sparkle icon + the quoted query in bold (17px/700), and below it four 56px preview thumbnails (8px radius/gap — matches the rendered size of chat-bubble images). Documented in `Style Guide - Action Cards.dc.html` (section: Action Cards).

## Chat behavior
- In the AI Magic chat, a query ending in "(generate)" always renders the **Generate Search Card** (regardless of the searchCardStyle tweak). The suffix is stripped from the displayed query, and the bot replies with "Generating "query" images."
- A query ending in "(search)" always renders the text-only **Search Action Card** (search icon + bold quoted query, no images) regardless of the searchCardStyle tweak. The suffix is stripped from the displayed query.
