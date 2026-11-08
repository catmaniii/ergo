# Maps

ergo has a map: AMap inside mainland China, OpenStreetMap abroad (say, in Singapore), switching automatically as you look around. Where you went on a given day, how long you stayed and where you took photos can be drawn on it; tell ergo "show where I went today on a map" and a map card appears in the chat. You can also just ask ergo "how long from home to the office?" or "any coffee shops nearby?" and it looks it up for you: AMap inside China, the free OpenStreetMap services abroad; the places and routes it finds can be put on a card too.

After this chapter you'll know where the map page is, how to talk to ergo on the map, how to see a day's footprints, how map cards in chats work, how to get a clearer map inside China (enter an AMap key), how to have ergo look up places and routes, and what map services can see.

## Open the map

**Where:** **Map** in the navigation. On a phone, it's under **More** when there's no room.

- Drag to move, pinch (scroll wheel on a computer) to zoom, double-tap to zoom in one level; the buttons at the top right zoom in and out too.
- The title bar is a single line: **Map**, the day picker (while **Footprints** is on), and at the right end the map picker (**Map: Automatic**, ⋮ on a phone), the **Footprints** switch and the ergo button, so you see as much map as possible.
- **Show my location**: the crosshair button at the bottom right, above the ergo button (on both AMap and OpenStreetMap). Tap it and the map moves to where you are now, zooms in to street level and draws a dot; when it knows how accurate the fix is, a faint circle goes around the dot (you're somewhere inside it). Tap it again within a minute to go straight back there. Where the location comes from:
  - in the ergo app on a HarmonyOS phone, the app's own location (it asks for location permission the first time);
  - in a browser (`http://127.0.0.1:8810` on the computer, or an https address), the browser's location; the browser asks whether to allow it;
  - when this device can't give a location (permission not granted, no fix within 10 seconds, or the Android app and LAN addresses, which can't use web location), ergo falls back to the latest location your phone sent, says "Couldn't get this device's location. This is where your phone was 12 minutes ago" under the map, and writes the time next to the dot; if your phone never sent one either, it says "Can't find your location".
  - Your location is used only on this page: it isn't stored (next time the map opens where you last looked yourself, not where you were located) and isn't sent anywhere outside ergo. On AMap, just like looking at any map inside China, AMap knows which area you're looking at (see "What map services can see" below).
  - If you're outside mainland China, the map switches to OpenStreetMap.
- The top left says which map is in use: **AMap** or **OpenStreetMap**.
- When you stop moving, ergo picks: inside mainland China with an AMap key, AMap; abroad, and in Hong Kong, Macau and Taiwan, OpenStreetMap.
- **Choose the map yourself**: **Map: Automatic**, first in the group at the right of the title bar (under ⋮ on a phone). It lists the maps you can use for the side you're looking at (inside or outside mainland China): **Automatic**, plus every map whose key is entered and working — inside China that's AMap and OpenStreetMap, outside it's only OpenStreetMap for now (AMap isn't offered abroad; a map plugin you install later, such as Google Maps, shows up here too). Your pick sticks and is remembered on this device, **separately for inside and outside mainland China**; pick **Automatic** again to go back to the rules above. If the map you picked stops working (its key broke, its plugin was turned off, or this device can't reach it), the map goes back to Automatic and says "… isn't available right now, so the map is back to Automatic". A map this device can't reach is marked **Can't connect** in the list. Footprints are still always on OpenStreetMap, whatever you picked.
- **Footprints are always shown on OpenStreetMap**: while **Footprints** at the right of the title bar is on, the map inside China is OpenStreetMap too and AMap's map program isn't loaded (see "What map services can see" below); turn **Footprints** off and it switches back to AMap inside China. **Footprints** is off by default, so inside China the map opens on AMap.
- Next time it opens where you last looked (remembered in this device's browser).
- With OpenStreetMap, the bottom right says "© OpenStreetMap contributors"; AMap prints its own logo and map approval number in a corner.
- With the dark appearance, the map is dark too.

## Talk to ergo on the map

ergo on the map page is the same ergo as always: the same conversation as the **Secretary** page and the sidebar next to **Browse**, so what you say here shows up there too. The difference is that everything you say from the map page carries **what you're looking at on the map**: the map's center, how far it's zoomed in, which map it's using (AMap, OpenStreetMap, or another map plugin you installed), which day's footprints you're looking at (and which place you picked), and which map card is open. So you can just say "any good food around here?", "draw this route" or "how long did I stay here that day?": ergo knows "here" means this part of the map (not where you are yourself — your location isn't sent along), looks places and routes up with the map you're using first (abroad with OpenStreetMap picked, it asks OpenStreetMap), and puts places and routes it wants to show you on map cards.

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

Footprints are **drawn only inside ergo and never sent to any map service**: ergo on your computer works them out from what your phone sent, without going online. See "What map services can see" below.

## Map cards in chats

Tell ergo "show where I went today on a map" or "where did I go yesterday?" and it first sums it up in a sentence ("You went to 3 places: the office, West Lake and home"), then puts a **map card** in the chat. It works the same by voice: what's read to you is the summary, and the map is on the card.

- **Footprint card**: the title says which day ("Where you went on 11/6"), a small map below shows that day's track, stays and photo spots, and under it "Stayed at 3 places · 6 photos" and the places you went. The small map can't be dragged; tap it (or **Open map** at its top right) to see that day on the map page. The small map uses OpenStreetMap, just like the map page does for footprints.
- **Places and routes you looked up**: after ergo looks up "how do I get from the office to West Lake?" or "coffee shops nearby", it can put the result on a card. Results from AMap **can only be drawn on AMap's own map** (AMap's rule), so the card has no small map: it lists the ways to get there (walking, driving…) or the places found, and says **Data from AMap**; tap **View on AMap** to see it drawn on AMap on the map page. Without an AMap web key the map page can't draw it and says why. Results are kept on the computer only for a little while and never saved (AMap doesn't allow it), so after a while the card says they've expired; just ask again. Results from OpenStreetMap (abroad, or inside China without an AMap key) get a small map as usual and say **Data from OpenStreetMap**; they're also kept only for a little while.
- **Points and routes ergo marks**: when it says "here are West Lake and Lingyin Temple" you get a card too, drawn like a footprint card.
- While the map page shows a card, the title bar shows the card's title and summary; tap **×** to go back to the map.

A card only stores the date (footprints are fetched fresh each time you open it, so if they're deleted on the phone side they disappear from the card too), the lookup's ID, or the few points ergo gave.

## A clearer map inside China: enter an AMap key

Without a key, inside China the map uses OpenStreetMap too and says "Enter an AMap key for a clearer map inside China"; tap **Set up** to go where you enter it.

**Where:** Settings · Data and devices · Data sources, then **AMap**.

1. Register on the AMap Open Platform (lbs.amap.com), complete personal verification, and create an app in the console;
2. Add a key to the app with the platform **Web (JS API)**. Under the same key there's a **security code**;
3. Enter the key and the security code in **Web (JS API) key** and **Security code**, then tap **Test and save**. ergo asks AMap once with them (about a fixed point — Tiananmen in Beijing — not your location) and saves them only if AMap accepts;
4. **Web service key** is optional: ergo needs it to look up places and routes (see the next section). Create another key in the console with the platform **Web service**.

If something's wrong it says why: wrong key, wrong security code, or the wrong platform for the key. If a newly entered one fails, the previously saved one stays in use.

The keys and security code stay on this computer. The security code is never sent to the web page: for the AMap requests that need it, ergo adds it on the computer before forwarding them to AMap.

To stop using it: tap **Disconnect** under **AMap**; the keys are deleted from this computer and the map uses OpenStreetMap inside China.

**A few rules for AMap keys** (from the AMap Open Platform [terms of service](https://lbs.amap.com/home/terms/), version of 2025-12-03):

- Apply for the key yourself on the AMap Open Platform (with personal developer verification). ergo doesn't ship a key and doesn't share one. Don't let others use your key either: clause 4.5 says it must not be transferred, rented out or lent.
- A personal developer key is for your own, non-commercial use (clause 3.1 says "personal research and study"). To deploy ergo in a company or organization, or to use ergo to provide a service to others, use enterprise verification and buy a commercial license from AMap (clause 3.2).
- AMap doesn't allow storing or caching its results (clause 3.5), so ergo uses them on the spot and doesn't keep them. AMap results are shown on the AMap map and credited to AMap (clauses 4.12.4, 7.7): the map page inside China is AMap's own map, and answers say "data from AMap".

## Have ergo look up places and routes

Just ask ergo:

- "How long from home to the office?": how long by car and which roads are jammed, how long by bus or subway, where to change and the fare;
- "Any coffee shops nearby?", "What's to eat near the office?", "Hawker centres nearby?": names, addresses and distances, nearest first;
- "Where's Xixi Wetland?", "How do I get to Xixi Wetland?", "Where am I now?"

**Who looks it up:** ergo picks by place; you don't have to. If you picked a map yourself (**Map: …**) and ergo knows which map you're looking at, it asks that one first (places and routes it finds can only be drawn on that provider's own map); if that one can't look things up (say, its lookup key isn't entered), ergo uses the next one for that side and says so in the answer. When ergo doesn't know which map you picked (you asked by voice, or the map page isn't open), it picks by the rules below.

- **Inside mainland China**: with the **Web service key** in, AMap — driving with live traffic, plus bus and subway transfers and fares.
- **Abroad** (places like Singapore, and Hong Kong, Macau and Taiwan): OpenStreetMap's free services, no key needed. **No transit and no live traffic**: driving times are estimated from road speed limits, and ergo gives driving and walking; for nearby places say what you're looking for ("coffee shop", "hawker centre") — it can't list everything nearby.
- **Without an AMap key, lookups inside China use OpenStreetMap too**, and ergo mentions that "places in China are looked up on OpenStreetMap, which may miss some shops and small roads". The same happens when **On-demand lookup** under **AMap** is off or AMap says the key is wrong.

ergo says where the data came from in its answers ("data from AMap" or "data from OpenStreetMap (© OpenStreetMap contributors)"). Results are looked up on the spot and used right away: not saved, not added to memory.

**OpenStreetMap's free services have their own rules**: places come from Nominatim and routes from the OSRM demo server, both public services run by volunteers, with no guarantee they're always up, at most one request per second, and meant for light personal use. ergo follows the rules: one request at a time, a little over a second apart, with ergo's own name on them; the same query within a day reuses the copy kept in the computer's memory (gone after a restart, never written to disk); and no suggestions while you type. When they're unavailable, ergo says "OpenStreetMap's free service is temporarily unavailable" — just ask again a bit later.

**Where "home" and "the office" are:** the names you gave under **Frequent places** in Settings · Data sources · Phone · Location. If you haven't named them yet, ergo tells you where to do it, or you can just give an address.

**Where "nearby" or "here" is:** the latest location the ergo app on your phone sent (start recording location in the app). If that location is a few hours old, ergo mentions that you may have moved on.

**Test lookup:** with the Web service key saved under **AMap**, tap **Run a test lookup**: ergo searches "Tiananmen" in Beijing once (a fixed word, not your location) and lists what it found, so you can see whether it works. Below it shows how many lookups you've made this month.

**Usage:** AMap's free quota for verified individual developers is roughly 5,000 place searches and 150,000 address and route lookups a month, free for one year; the AMap console has the real numbers. ergo counts lookups per month (only the counts, not what was looked up) and Settings · Checkup warns you when you're getting close. When AMap says the limit is reached, lookups are too frequent, or the key is wrong, ergo tells you so; for a wrong key the **AMap** row says it needs authorization — enter the key again (until then, lookups inside China use OpenStreetMap). OpenStreetMap needs no key and isn't counted.

## What map services can see

- **OpenStreetMap**: your computer fetches the map images for the page, so OpenStreetMap sees the computer's network address and the area you're looking at, not your phone's. Fetched images are kept on the computer for a while and not fetched again.
- **AMap**: for maps inside China, your browser fetches map data directly from AMap, so AMap sees this device's network address and the area you're looking at.
- **When looking up places and routes**: only when you ask, the start, the destination or the "nearby" spot for that one lookup goes to whoever looks it up — AMap inside China, OpenStreetMap's public services abroad (and inside China without an AMap key) ("home" and "the office" send the center of the place you named; "nearby" sends the one latest location from your phone). When finding the other end of a route by name, the start goes along too, so the nearest match is picked.
- **Where you went each day and where your photos were taken are never sent to any map service**: ergo on your computer works out your footprints, the page gets them only from ergo, and ergo doesn't send these points to OpenStreetMap, AMap or any other map service.
  - **Footprints are always shown on OpenStreetMap**: the page draws the points itself, they're never handed to AMap's map program, and that program isn't loaded for them (the small maps on footprint cards in chats too). AMap's map is drawn by AMap's program running in the page, which can see what it's asked to draw, so footprints are kept away from it. If this page already loaded AMap earlier (you looked at China with **Footprints** off, or at a route from AMap), its program is already in the page; footprints still aren't handed to it after you turn **Footprints** on, and reloading the page removes it completely.
  - The map itself still has to be fetched: when you look at a day's footprints the map moves to that area, so the map service knows you're looking at it (just like when you drag the map yourself).
- **When you tap Show my location**: your location isn't sent to any map service or stored. But the map moves to your area and fetches the map for it, so the map service knows which area you're looking at; on AMap inside China your dot is also drawn by AMap's program in the page (like a route from AMap), so that program can see it. To keep it from AMap, turn **Footprints** on before locating (footprints always use OpenStreetMap).

## Turn the map off

Settings · Plugins, disable **Map**. While it's disabled, earlier map cards in chats say the Map plugin isn't enabled. Removing it with **Delete its data** deletes the AMap keys you entered, the map images stored on the computer, the monthly lookup counts and the map cards in chats. To only stop ergo from using AMap for lookups, turn off **On-demand lookup** under **AMap** (lookups inside China then use OpenStreetMap).
