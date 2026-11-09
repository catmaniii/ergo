# Maps

ergo has a map: AMap inside mainland China; abroad (say, in Singapore) Google Maps once you enter Google keys, otherwise AMap; it switches automatically as you look around, and the map page, footprints and the previews on map cards in chats all use the same map. Where you went on a given day, how long you stayed and where you took photos can be drawn on it; tell ergo "show where I went today on a map" and a map card appears in the chat. You can also just ask ergo "how long from home to the office?" or "any coffee shops nearby?" and it looks it up for you: AMap inside China, the free OpenStreetMap services abroad (Google with Google keys); the places and routes it finds can be put on a card too.

After this chapter you'll know where the map page is, how to talk to ergo on the map, how to see a day's footprints, how map cards in chats work, how to get a clearer map inside China (enter an AMap key), how to use Google Maps abroad (create keys in Google Cloud without surprise charges), how to have ergo look up places and routes, and what map services can see.

## Open the map

**Where:** **Map** in the navigation. On a phone, it's under **More** when there's no room.

- Drag to move, pinch (scroll wheel on a computer) to zoom, double-tap to zoom in one level; the buttons at the top right zoom in and out too.
- The title bar is a single line: **Map**, the day picker (while **Footprints** is on), and at the right end the map picker (**Map: Automatic**, ⋮ on a phone), the **Footprints** switch and the ergo button, so you see as much map as possible.
- **Show my location**: the crosshair button at the bottom right, above the ergo button (on both AMap and OpenStreetMap). Tap it and the map moves to where you are now, zooms in to street level and draws a dot; when it knows how accurate the fix is, a faint circle goes around the dot (you're somewhere inside it). Tap it again within a minute to go straight back there. Where the location comes from:
  - in the ergo app on a HarmonyOS phone, the app's own location (it asks for location permission the first time);
  - in a browser (`http://127.0.0.1:8810` on the computer, or an https address), the browser's location; the browser asks whether to allow it;
  - when this device can't give a location (permission not granted, no fix within 10 seconds, or the Android app and LAN addresses, which can't use web location), ergo falls back to the latest location your phone sent, says "Couldn't get this device's location. This is where your phone was 12 minutes ago" under the map, and writes the time next to the dot; if your phone never sent one either, it says "Can't find your location".
  - Your location is used only on this page: it isn't stored (next time the map opens where you last looked yourself, not where you were located) and isn't sent anywhere outside ergo. On AMap, just like looking at any map inside China, AMap knows which area you're looking at (see "What map services can see" below).
  - If you're outside mainland China, the map switches to the current map for abroad (see below).
- The top left says which map is in use: **AMap**, **Google Maps** or **OpenStreetMap**.
- When you stop moving, ergo picks: **inside mainland China**, AMap with an AMap key, otherwise OpenStreetMap; **abroad, and in Hong Kong, Macau and Taiwan**, Google Maps once its keys are entered (see "Google Maps outside China" below), otherwise AMap, and OpenStreetMap only if AMap isn't set up either. If that map can't load on this device (can't connect, key refused), it falls back to the next one too. AMap's detailed map abroad is its "world map" feature, which you enable by filing a ticket on the AMap Open Platform; without it the map abroad may be very sparse, and you can pick OpenStreetMap for abroad under **Map: Automatic**.
- **Current map**: one for inside China and one for abroad — whichever you picked under **Map: …**, or what **Automatic** picks above if you didn't. The map page, the map with **Footprints** on and the previews on map cards in chats all use it as the base map (ergo draws the points and lines on top itself). The one exception: places and routes looked up with AMap or Google (their rules) are always drawn on the map that looked them up; see "Map cards in chats" below.
- **Choose the map yourself**: **Map: Automatic**, first in the group at the right of the title bar (under ⋮ on a phone). It lists the maps you can use for the side you're looking at (inside or outside mainland China): **Automatic**, plus every map whose key is entered and working, with the ones Automatic would pick first and the ones you can only pick by hand after them — inside China that's AMap, OpenStreetMap and Google Maps, outside it's Google Maps, AMap and OpenStreetMap (Google Maps only appears once its browser key is entered, AMap once its web key is). Your pick sticks and is remembered on this device, **separately for inside and outside mainland China**; pick **Automatic** again to go back to the rules above. If the map you picked stops working (its key broke, its plugin was turned off, or this device can't reach it), the map goes back to Automatic and says "… isn't available right now, so the map is back to Automatic". A map this device can't reach is marked **Can't connect** in the list. The last line of the list says the map page, footprints and map cards in chats all use this map as the base map, and lookups try it first too; footprints and the points and lines ergo draws are drawn only on this device, so this provider only knows which area you're looking at.
- **Footprints use the current map too**: while **Footprints** at the right of the title bar is on, your footprints are drawn on top of the current map (usually AMap inside China); turning **Footprints** on or off doesn't change the map. **Footprints are drawn only on this device**: ergo lays its own layer over the map and draws the track, stays and photo spots on it, never handing them to AMap or Google — they only see which area of the map you're looking at (see "What map services can see" below). **Footprints** is off by default.
- While AMap's or Google's map program is still loading, the map area stays blank and says "Loading AMap…" instead of flashing OpenStreetMap first; only if loading fails or takes over 20 seconds does it fall back to the next map.
- Next time it opens where you last looked (remembered in this device's browser).
- With OpenStreetMap, the bottom right says "© OpenStreetMap contributors"; AMap prints its own logo and map approval number in a corner.
- With the dark appearance, the map is dark too.

## Talk to ergo on the map

ergo on the map page is the same ergo as always: the same conversation as the **Secretary** page and the sidebar next to **Browse**, so what you say here shows up there too. The difference is that everything you say from the map page carries **what you're looking at on the map**: the map's center, how far it's zoomed in, which map it's using (AMap, OpenStreetMap, or another map plugin you installed), which day's footprints you're looking at (and which place you picked), and which map card is open. So you can just say "any good food around here?", "draw this route" or "how long did I stay here that day?": ergo knows "here" means this part of the map (not where you are yourself — your location isn't sent along), looks places and routes up with the map you're using first (abroad with OpenStreetMap picked, it asks OpenStreetMap, with or without **Footprints**; when the map abroad is AMap, lookups use OpenStreetMap — AMap only looks things up inside China — and the results are still drawn on AMap), and puts places and routes it wants to show you on map cards.

- **The chat on the right**: tap the ergo button at the right end of the title bar to open it, and tap again to close. On a computer (when the map page is wide enough) it sits on the right and the map makes room instead of being covered; drag the divider between them to resize. On a phone it covers the whole map page; tap **›** at the top or use the phone's back gesture to close it. Whether it's open and how wide you dragged it are remembered on this device.
- **The ergo button at the bottom right**: while the chat is closed there's a round ergo button at the bottom right of the map (the same one as on web pages in **Browse**), with **Show my location** above it. Tap it and a small box opens above it for typing; press and hold to talk, let go to send, and slide up before letting go to cancel (only typing when the voice plugin is disabled). ergo's reply, a sentence or two, shows in the box and in the conversation; **Open on the right** at the top right of the box opens the chat on the right with the whole conversation. The button isn't shown while the chat is open.
- In the conversation, what you said on the map page is marked **Said on the map** or **Typed / Said with the floating button on the map**.

## Your footprints: where you went on a day

Once the ergo app on your phone records your location (Settings · Data sources · **Phone · Location**; tap **Start recording location** in the app) and is connected to your photo album, the map page can draw a day's footprints.

- **Turn it on**: **Footprints** at the right of the title bar (a pin icon on a phone) is off by default. Tap it and the day is drawn, the map moves to show all of it, and the day picker appears in the title bar. Tap again to turn it off (remembered in this device's browser).
- **Pick a day**: in the title bar, right after **Map**. The arrows go to the previous and next day; tap the date in the middle to pick one; after it comes a summary of the day ("Stayed at 3 places · 6 photos"). On a phone, where the whole line doesn't fit, the date reads "11/07", the summary "3 places · 6 photos", and **Footprints** is just a pin icon. The map opens on today; if today has no footprints yet it jumps to the latest day that has some. On a day with nothing it says **No footprints on this day**, and the button next to it goes to the latest earlier day with footprints.
- **What's drawn**:
  - A line: your locations that day, joined in time order. The part where you stayed in one place shrinks to a single point instead of a tangle, and the line breaks where nothing was recorded for an hour and a half or more, instead of drawing a straight line across the gap;
  - Pins: where you **stayed** — a run of locations all within 400 meters for at least 15 minutes counts as a stay (the same rule as the daily location summary in memory). Next to each pin: the name and how long you stayed in total. Named places ("Home", "Office") show their name; others show the place name your phone worked out; with neither, the time you arrived. Several visits to the same place (home in the morning and again at night) share one pin;
  - Small hollow dots: where photos were taken, with the time; photos taken close together (within half an hour and 100 meters) share a dot that says how many. Only the time and place — **no photos are shown**;
  - Circles: the areas of the frequent places you named. Places you didn't visit that day have their name in the circle.
- **Details**: on a computer, a list of the day runs down the left of the map (each stay with its times and length, and photos taken outside stays); tap a row to go there, and tap a stay to open its details below it. On a phone, tap a pin and a card appears under the map; tap the "Stayed at 3 places…" line in the strip to see the day as a list. Details show the place's name, its place name, each visit's times, the total time, and how many photos you took there. Unnamed places have **Name this place**, which takes you to **Frequent places** under Settings · Data sources · **Phone · Location**.
- **Fold or close it**: on a computer, the list on the left has **fold** and **×** at the top — folded, it shrinks to a small **This day** button at the top left that opens it again; closed, tap the "Stayed at 3 places…" line in the title bar to bring it back. On a phone the card under the map is a drawer: drag the little bar at its top down (or tap it) to lower it until only the title line shows, drag down again to close it, and drag up to raise it. Folded, closed and lowered are all remembered on this device.
- A footprint card in a chat opens this page on that day (even if **Footprints** was off, without changing the switch you left it at).

ergo on your computer works out your footprints from what your phone sent, without going online; they're drawn only on this device, on top of the current map, and never handed to AMap or Google. See "What map services can see" below.

## Map cards in chats

Tell ergo "show where I went today on a map" or "where did I go yesterday?" and it first sums it up in a sentence ("You went to 3 places: the office, West Lake and home"), then puts a **map card** in the chat. It works the same by voice: what's read to you is the summary, and the map is on the card.

- **Footprint card**: the title says which day ("Where you went on 11/6"), a preview below shows that day's track and the places you stayed, and under it "Stayed at 3 places · 6 photos" and the places you went. The preview can't be dragged; tap **Open map** at its top right to see that day on the map page.
- **Places and routes you looked up**: after ergo looks up "how do I get from the office to West Lake?" or "coffee shops nearby", it can put the result on a card. Results from AMap or Google **can only be drawn on their own map** (their rules), so the card's preview is a map from whoever looked it up (whatever map you picked), with the places found (numbered) or the route; below it the card lists the ways to get there (walking, driving…) or the places found, and says **Data from AMap**; tap **Open map** to see it drawn on AMap on the map page. If the preview can't be fetched (Google's Maps Static API isn't enabled, the free usage ran out, or that service had an error), the card is text only, with "No preview: …" and **View on AMap**. Results are kept on the computer only for a little while and never saved (AMap doesn't allow it), so after a while the card says they've expired; just ask again. Results from OpenStreetMap (abroad without Google, or inside China without an AMap key) can be drawn on any map, so their preview uses the current map like a footprint card, and they say **Data from OpenStreetMap**; they're also kept only for a little while.
- **Points and routes ergo marks**: when it says "here are West Lake and Lingyin Temple" you get a card too, drawn like a footprint card.
- **Which map the preview uses**: footprint cards, points and routes ergo marks, and results from OpenStreetMap use the current map for the side (inside or outside China) the card's content is on; results from AMap or Google use whoever looked them up. For AMap and Google, the computer asks them for a **plain map** with your key (AMap's web service key, Google's server key) — it only says which area (center, zoom level, size, light or dark), without a single point or line, and the key never goes into the page; the preview is fetched only when you scroll near the card, and isn't stored. The page draws the points (numbered, however many there are) and lines on top of it, leaving the provider's logo and copyright strip uncovered. AMap's static maps have no dark version, so they're dimmed a little with the dark appearance; Google's come in dark. When the current map is OpenStreetMap, or the AMap or Google preview can't be fetched, the page draws footprints, points and routes on OpenStreetMap itself.
- While the map page shows a card, the title bar shows the card's title and summary; tap **×** to go back to the map.
- When you open a card looked up with AMap or Google, the map on this screen temporarily uses that map (the map you picked stays remembered), with "These came from AMap, so they're shown on AMap" above it; tap **×** to close the card and you're back on your current map. If that map can't load on this device (Google from inside China, say), the map area shows a large static picture of the card instead and says "This device can't reach Google Maps, so here's a picture for now"; if even that can't be fetched, it says why the results can't be drawn.
- Tapping a card in the sidebar next to **Browse** works the same: the sidebar closes and the map page shows that card.
- Select an address on a page in **Browse** and tap **Show on map**: no card, the map page opens straight to the place found (the title bar shows the text you selected); see [Built-in browser](browser.en.md#selected-an-address-show-on-map-directions).

A card only stores the date (footprints are fetched fresh each time you open it, so if they're deleted on the phone side they disappear from the card too), the lookup's ID, or the few points ergo gave.

## A clearer map inside China: enter an AMap key

Without a key, inside China the map uses OpenStreetMap too and says "Enter an AMap key for a clearer map inside China"; tap **Set up** to go where you enter it.

**Where:** Settings · Data and devices · Data sources, then **AMap**.

1. Register on the AMap Open Platform (lbs.amap.com), complete personal verification, and create an app in the console;
2. Add a key to the app with the platform **Web (JS API)**. Under the same key there's a **security code**;
3. Enter the key and the security code in **Web (JS API) key** and **Security code**, then tap **Test and save**. ergo asks AMap once with them (about a fixed point — Tiananmen in Beijing — not your location) and saves them only if AMap accepts;
4. **Web service key** is optional: ergo needs it to look up places and routes (see the next section), and AMap previews (static maps) on map cards in chats use it too. Create another key in the console with the platform **Web service**.

If something's wrong it says why: wrong key, wrong security code, or the wrong platform for the key. If a newly entered one fails, the previously saved one stays in use.

The keys and security code stay on this computer. The security code is never sent to the web page: for the AMap requests that need it, ergo adds it on the computer before forwarding them to AMap.

To stop using it: tap **Disconnect** under **AMap**; the keys are deleted from this computer and the map uses OpenStreetMap inside China (and abroad without Google).

AMap's map works abroad too: without Google, **Automatic** uses it abroad. The detailed map abroad is AMap's "world map" feature, which you enable by filing a ticket on the AMap Open Platform; without it the map abroad may be very sparse — just pick OpenStreetMap for abroad under **Map: …**. AMap place and route lookups still cover mainland China only.

**A few rules for AMap keys** (from the AMap Open Platform [terms of service](https://lbs.amap.com/home/terms/), version of 2025-12-03):

- Apply for the key yourself on the AMap Open Platform (with personal developer verification). ergo doesn't ship a key and doesn't share one. Don't let others use your key either: clause 4.5 says it must not be transferred, rented out or lent.
- A personal developer key is for your own, non-commercial use (clause 3.1 says "personal research and study"). To deploy ergo in a company or organization, or to use ergo to provide a service to others, use enterprise verification and buy a commercial license from AMap (clause 3.2).
- AMap doesn't allow storing or caching its results (clause 3.5), so ergo uses them on the spot and doesn't keep them. AMap results are shown on the AMap map and credited to AMap (clauses 4.12.4, 7.7): the map page inside China is AMap's own map, and answers say "data from AMap".

## Google Maps outside China: enter two Google keys

With the "Google Maps" plugin installed (it is by default) and Google keys entered:

- The map page uses Google Maps **outside mainland China** automatically (the top-left label says "Google Maps"), with better shop names and street numbers than AMap's world map or OpenStreetMap;
- When you ask ergo about places and routes outside mainland China it uses Google: **transit and subway plans, and driving times with current traffic**; "hawker centres nearby" are listed nearest first, and the answer says "Data from Google Maps";
- In the map switch ("Map: …") you can **pick "Google Maps" both in China and abroad**: picked in China it works too (ergo converts the coordinates: Google's street map in China uses the same shifted coordinates as AMap). If this device can't reach Google from China, the switch marks it "Can't connect", the map says so and goes back to "Automatic". Place and route lookups are made by the computer, so they work as long as the computer can reach Google.
- Cards in chats for things looked up with Google get a Google preview (this needs one more API, Maps Static API — see step 3 below), and footprint, point and route cards abroad use Google previews too (only a plain map is asked from Google; the page draws the points and lines); with **Footprints** on, footprints are drawn on top of Google Maps as well (only on this device).

Without keys, with the plugin disabled, or over the free usage, AMap is used abroad (OpenStreetMap if AMap isn't set up either).

**Where:** Settings · Data & devices · Data sources, tap "Google Maps". There are two keys:

- **Browser key**: for the Google basemap on the map page (Maps JavaScript API). Google's design puts it into the web page, where anyone can read it in the page source, so always give it a "Websites" restriction in Google Cloud (step 5 below). Google only lets a web page test it: saving only checks that it looks like a key, and whether it's right is known the first time the map page uses the Google basemap. If Google rejects it, the map switches to the next map Automatic would pick (AMap or OpenStreetMap) and the "Google Maps" row says it needs authorization — fix it and enter it again.
- **Server key**: for ergo's place and route lookups (Places API (New), Routes API, Geocoding API), and for previews on map cards in chats (Maps Static API). It stays on this computer and never goes into the web page. When you tap "Test and save", ergo asks each of the three APIs once (about a fixed place — the Merlion Park in Singapore — not your location) and saves the key only if all three answer; if an API isn't enabled or the key's restrictions refuse it, it says which one and how to fix it. Then it fetches one tiny static map to try Maps Static API: if that isn't enabled, saving still goes ahead and the line below just says "Card previews (Maps Static API): not enabled"; cards for things looked up with Google are text only until you enable it. If a newly entered key fails, the previously saved one keeps being used.

You can enter just one of them: only the browser key gives the Google basemap while lookups stay on OpenStreetMap; only the server key gives Google lookups and card previews while the basemap abroad is AMap or OpenStreetMap (places and routes from Google can only be drawn on a Google map, so when you open such a card the map page says why they can't be drawn).

### Enable the APIs, create the keys and avoid charges in Google Cloud

Google Maps requires billing on the project (a card on file); each item has a free amount every month and anything beyond it is billed. ergo never touches your payment details; you do the following yourself in the Google Cloud console (console.cloud.google.com). **Please do steps 7 and 8 without fail:**

1. **Create a project**: project picker at the top left → "New project", give it a name (e.g. ergo-maps).
2. **Enable billing**: left menu "Billing", link a billing account to the project (create one and add a card if you have none). Google requires a billing account to use the map services.
3. **Enable five APIs**: under "APIs & Services · Library" search for and enable **Maps JavaScript API**, **Places API (New)** (the one with "New"), **Routes API**, **Geocoding API** and **Maps Static API** (previews on map cards in chats).
4. **Create two keys**: "APIs & Services · Credentials" → "Create credentials · API key", twice; rename them "ergo browser" and "ergo server".
5. **Restrict the browser key**: edit "ergo browser" —
   - "Application restrictions": "Websites", adding each address you open ergo with on its own line: on this computer `http://127.0.0.1:8810/*` and `http://localhost:8810/*`, plus the address you use from outside (e.g. `https://your-external-address/*`); if other computers or phones open it through a LAN address, add that too. Settings · Data sources · Google Maps shows the address this device opened ergo with.
   - "API restrictions": "Restrict key", tick **Maps JavaScript API** only.
6. **Restrict the server key**: edit "ergo server" —
   - "Application restrictions": "IP addresses", with this computer's public IP (search "what is my IP"; a home connection's IP may change, and then you'll need to update it — you can skip this one if that's a hassle, but always set the API restriction);
   - "API restrictions": "Restrict key", tick **Places API (New)**, **Routes API**, **Geocoding API** and **Maps Static API** only.
7. **Set a budget alert**: left menu "Billing · Budgets & alerts" → "Create budget", pick the project, enter a small amount you're fine with (e.g. 1 USD), keep the 50%, 90% and 100% thresholds. **A budget only emails you; it does not stop anything.**
8. **Set daily caps (this is what actually prevents charges)**: under "APIs & Services", open each API → "Quotas & System Limits" and lower "Requests per day". Google suggests "monthly free amount ÷ 31"; once a cap is reached that API stops for the rest of the day and resumes the next day, with no extra charges:

   | API | Free each month (2026-11; the console has the real numbers) | Suggested daily cap |
   |---|---|---|
   | Maps JavaScript API | 10,000 map loads | 300 |
   | Places API (New) | 5,000 place searches (Text Search Pro), 5,000 nearby searches (Nearby Search Pro) | 150 |
   | Geocoding API | 10,000 | 300 |
   | Routes API | 10,000 walking and transit (Compute Routes Essentials), 5,000 driving with traffic (Compute Routes Pro) | 150 |
   | Maps Static API | 10,000 static maps | 300 |

9. Enter the two keys in Settings · Data sources · Google Maps and tap "Test and save".

**If you entered your keys before card previews existed**: in Google Cloud, also enable **Maps Static API** (step 3), tick it in the server key's "API restrictions" (step 6) and give it a daily cap (step 8), then tap "Test and save" once more in Settings · Data sources · Google Maps; the line under the server key changes to "Card previews (Maps Static API): working". Everything else works without it; cards for things looked up with Google are just text, and cards abroad are drawn with AMap or OpenStreetMap.

### Usage and going over

ergo counts each month's requests per Google billing item (only counts, not what was looked up): map loads, place search, nearby, addresses and locations, walking and transit routes, driving routes, card previews. Settings · Data sources · Google Maps lists "used this month / free each month", and the "Map" block of the health check has "Google Maps usage".

- When an item reaches 80% of its free amount, the health check warns;
- **When an item reaches its free amount, ergo pauses Google**: if map loads ran out, the map page uses AMap abroad (OpenStreetMap without AMap); if a lookup item ran out, place and route lookups use OpenStreetMap and the answer says so; if card previews ran out, cards in chats are drawn by the page on OpenStreetMap (things looked up with Google are just text). It resumes next month.
- To keep going anyway, tick "Keep using it after the free usage" under "Google Maps"; Google bills the extra (the health check still shows it in red).

ergo's counts may not match Google's bill exactly (Google's months follow Pacific time, and the key tests count too); the Google Cloud console is the source of truth, and the daily caps in step 8 are what really prevent charges.

### Google's rules

From the Google Maps Platform Terms of Service and the API policies (read 2026-11):

- **No caching**: Google only allows storing place IDs long-term and coordinates for up to 30 days. ergo stores neither: results are used right away, never written to disk or into memory; card previews are fetched fresh each time and not stored on the computer (Google's caching headers are passed to the browser as they are).
- **Only on a Google map**: Google content may not be used with another provider's map. Places and routes from Google are drawn only on Google Maps: chat cards show a Google static map, and opening one temporarily switches the map page to the Google basemap; Google's static maps only carry the points and lines ergo hands them and are never combined with another provider's map.
- **Attribution**: Google Maps prints its Google logo and copyright line in the corner, and ergo never covers them; results not on a map (answers, cards) say "Data from Google Maps".
- The keys are yours: don't lend them out, and never post the server key online.

To stop: tap "Disconnect" under "Google Maps" — both keys are deleted from this computer (they still exist in Google Cloud; delete them there if you're done) and OpenStreetMap is used abroad. To only stop ergo from looking things up with Google, turn off "On-demand lookup" for "Google Maps". You can also disable "Google Maps" in Settings · Plugins; removing it with "Delete its data" deletes the keys and the usage counts.

## Have ergo look up places and routes

Just ask ergo:

- "How long from home to the office?": how long by car and which roads are jammed, how long by bus or subway, where to change and the fare;
- "Any coffee shops nearby?", "What's to eat near the office?", "Hawker centres nearby?": names, addresses and distances, nearest first;
- "Where's Xixi Wetland?", "How do I get to Xixi Wetland?", "Where am I now?"

**Who looks it up:** ergo picks by place; you don't have to. If you picked a map yourself (**Map: …**) and ergo knows which map you're looking at, it asks that one first (places and routes it finds can only be drawn on that provider's own map); if that one can't look things up (say, its lookup key isn't entered), ergo uses the next one for that side and says so in the answer. When ergo doesn't know which map you picked (you asked by voice, or the map page isn't open), it picks by the rules below.

- **Inside mainland China**: with the **Web service key** in, AMap — driving with live traffic, plus bus and subway transfers and fares.
- **Abroad** (places like Singapore, and Hong Kong, Macau and Taiwan): with a Google server key, Google (transit and live traffic, see the previous section); otherwise OpenStreetMap's free services, no key needed. **No transit and no live traffic**: driving times are estimated from road speed limits, and ergo gives driving and walking; for nearby places say what you're looking for ("coffee shop", "hawker centre") — it can't list everything nearby.
- **Without an AMap key, lookups inside China use OpenStreetMap too**, and ergo mentions that "places in China are looked up on OpenStreetMap, which may miss some shops and small roads". The same happens when **On-demand lookup** under **AMap** is off or AMap says the key is wrong.

ergo says where the data came from in its answers ("data from AMap" or "data from OpenStreetMap (© OpenStreetMap contributors)"). Results are looked up on the spot and used right away: not saved, not added to memory.

**OpenStreetMap's free services have their own rules**: places come from Nominatim and routes from the OSRM demo server, both public services run by volunteers, with no guarantee they're always up, at most one request per second, and meant for light personal use. ergo follows the rules: one request at a time, a little over a second apart, with ergo's own name on them; the same query within a day reuses the copy kept in the computer's memory (gone after a restart, never written to disk); and no suggestions while you type. When they're unavailable, ergo says "OpenStreetMap's free service is temporarily unavailable" — just ask again a bit later.

**Where "home" and "the office" are:** the names you gave under **Frequent places** in Settings · Data sources · Phone · Location. If you haven't named them yet, ergo tells you where to do it, or you can just give an address.

**Where "nearby" or "here" is:** the latest location the ergo app on your phone sent (start recording location in the app). If that location is a few hours old, ergo mentions that you may have moved on.

**Test lookup:** with the Web service key saved under **AMap**, tap **Run a test lookup**: ergo searches "Tiananmen" in Beijing once (a fixed word, not your location) and lists what it found, so you can see whether it works. Below it shows how many lookups you've made this month.

**Usage:** AMap's free quota for verified individual developers is roughly 5,000 place searches and 150,000 address and route lookups a month, free for one year; the AMap console has the real numbers. Each AMap preview (static map) on a chat card counts once too, together with address and route lookups. ergo counts lookups per month (only the counts, not what was looked up) and Settings · Checkup warns you when you're getting close. When AMap says the limit is reached, lookups are too frequent, or the key is wrong, ergo tells you so; for a wrong key the **AMap** row says it needs authorization — enter the key again (until then, lookups inside China use OpenStreetMap). OpenStreetMap needs no key and isn't counted.

## What map services can see

- **OpenStreetMap**: your computer fetches the map images for the page, so OpenStreetMap sees the computer's network address and the area you're looking at, not your phone's. Fetched images are kept on the computer for a while and not fetched again.
- **AMap**: for maps inside China, your browser fetches map data directly from AMap, so AMap sees this device's network address and the area you're looking at. AMap previews on chat cards are fetched by the computer, so AMap sees the computer's network address and that area.
- **Google Maps**: when the map shows Google Maps, your browser fetches map data directly from Google, so Google sees this device's network address and the area you're looking at; for place and route lookups the computer sends Google only the start, the end or the "nearby" spot of that one question. Google previews on chat cards are fetched by the computer with the server key, so Google sees the computer's network address and that area.
- **When looking up places and routes**: only when you ask, the start, the destination or the "nearby" spot for that one lookup goes to whoever looks it up — AMap inside China, OpenStreetMap's public services abroad (and inside China without an AMap key) ("home" and "the office" send the center of the place you named; "nearby" sends the one latest location from your phone). When finding the other end of a route by name, the start goes along too, so the nearest match is picked.
- **Footprints and the points and lines ergo draws are drawn only on this device; AMap and Google only see which area of the map you're looking at** (since 2026-11-09): ergo on your computer works out your footprints without going online; when they're drawn —
  - **On the map page**: AMap and Google only provide the base map. ergo lays its own layer over it and draws footprints (track, stays, photo spots), places and routes you looked up, and your current location on that layer, which moves with the map; none of it is handed to AMap's or Google's program, so they only know which area the map shows (center and zoom level).
  - **Google Maps runs in a separate sealed frame**: Google's program runs inside the frame and can't read ergo's page (footprints and the chat are outside it). **AMap can't run in such a frame** (it fetches the map through your computer, and the computer can't tell requests from the frame are yours), so AMap's program runs in the same page as ergo: ergo hands it no points or lines, but its program could technically read the page. If that bothers you, pick OpenStreetMap for inside China under **Map: …**.
  - **Cards in chats**: the preview is a plain map the computer asks for, and the request only has the center, zoom level, size and light or dark — not a single point or line; the page draws the points and lines on top of it.
  - The computer fetches OpenStreetMap's map images for the page and the page draws footprints itself, so they aren't sent to OpenStreetMap.
  - The map itself still has to be fetched: when you look at a day's footprints the map moves to that area, so the map service knows you're looking at it (just like when you drag the map yourself).
- **When you tap Show my location**: your location isn't sent to any map service or stored; the dot and accuracy circle are drawn on ergo's own layer too. But the map moves to your area and fetches the map for it, so the map service knows which area you're looking at. To keep that from a map service, pick OpenStreetMap under **Map: …** before locating (the computer fetches OpenStreetMap's images for you).

## Choose map providers, turn the map off

Settings · Plugins has four map plugins: **Map** (the map page, footprints, map cards in chats, place and route lookups) and the three map providers **OpenStreetMap**, **AMap** and **Google Maps**, each of which can be disabled on its own. Keys you entered for AMap and Google, the usage counts and the choices you made under "Map: …" on this device are all kept as they are — nothing to enter or pick again.

- **Disable one provider**: it's no longer listed under "Map: …" and Automatic skips it; a side where you'd picked it by hand goes back to Automatic with a note. Disable **AMap**, for example, and Automatic inside China is OpenStreetMap (with Google on you can still pick Google by hand); disable **OpenStreetMap** and places neither AMap nor Google can show have no map. Lookups only ask the providers that are on, too.
- **All three disabled** (or none of those on has a key): the map area stays empty and says "No map is available — turn one on in Settings · Plugins", with a button that goes there (when some are on but unusable it says so and the button goes to Settings · Data sources). Map cards in chats are text only. Your footprints and the points ergo marked are still there and show up once a provider is on.
- **Disable Map**: the three providers stop with it (they all need the Map plugin); the map page and **Map** in the navigation go away, and earlier map cards in chats say the Map plugin isn't enabled. When you turn **Map** back on, providers that were stopped along with it need turning on again one by one in Settings · Plugins; if **Map** was off in the settings from the start, the providers come back with it.
- **Remove with Delete its data**: **Map** deletes the map cards in chats; **OpenStreetMap** deletes the map images stored on the computer; **AMap** deletes the keys and security code and the monthly lookup counts; **Google Maps** deletes its two keys and usage. Places mentioned in chats are chat history and stay.

To only stop ergo from using AMap for lookups, turn off **On-demand lookup** under Settings · Data sources · **AMap** (lookups inside China then use OpenStreetMap).
