# Maps

ergo has a map: AMap inside mainland China, OpenStreetMap abroad (say, in Singapore), switching automatically as you look around. Where you went on a given day, how long you stayed and where you took photos can be drawn on it; tell ergo "show where I went today on a map" and a map card appears in the chat.

After this chapter you'll know where the map page is, how to see a day's footprints, how map cards in chats work, how to get a clearer map inside China (enter an AMap key), and what map services can see.

## Open the map

**Where:** **Map** in the navigation. On a phone, it's under **More** when there's no room.

- Drag to move, pinch (scroll wheel on a computer) to zoom, double-tap to zoom in one level; the buttons at the top right zoom in and out too.
- The top left says which map is in use: **AMap** or **OpenStreetMap**.
- When you stop moving, ergo picks: inside mainland China with an AMap key, AMap; abroad, and in Hong Kong, Macau and Taiwan, OpenStreetMap.
- **Footprints are always shown on OpenStreetMap**: while **Footprints** at the top right of the title bar is on, the map inside China is OpenStreetMap too and AMap's map program isn't loaded (see "What map services can see" below); turn **Footprints** off and it switches back to AMap inside China.
- Next time it opens where you last looked (remembered in this device's browser).
- With OpenStreetMap, the bottom right says "© OpenStreetMap contributors"; AMap prints its own logo and map approval number in a corner.
- With the dark appearance, the map is dark too.

## Your footprints: where you went on a day

Once the ergo app on your phone records your location (Settings · Data sources · **Phone · Location**; tap **Start recording location** in the app) and is connected to your photo album, the map page can draw a day's footprints.

- **Pick a day**: the strip under the title bar. The arrows go to the previous and next day; tap the date in the middle to pick one. The map opens on today; if today has no footprints yet it jumps to the latest day that has some. On a day with nothing it says **No footprints on this day**, and the button next to it goes to the latest earlier day with footprints.
- **What's drawn**:
  - A line: your locations that day, joined in time order. The part where you stayed in one place shrinks to a single point instead of a tangle, and the line breaks where nothing was recorded for an hour and a half or more, instead of drawing a straight line across the gap;
  - Pins: where you **stayed** — a run of locations all within 400 meters for at least 15 minutes counts as a stay (the same rule as the daily location summary in memory). Next to each pin: the name and how long you stayed in total. Named places ("Home", "Office") show their name; others show the place name your phone worked out; with neither, the time you arrived. Several visits to the same place (home in the morning and again at night) share one pin;
  - Small hollow dots: where photos were taken, with the time; photos taken close together (within half an hour and 100 meters) share a dot that says how many. Only the time and place — **no photos are shown**;
  - Circles: the areas of the frequent places you named. Places you didn't visit that day have their name in the circle.
- **Details**: on a computer, a list of the day runs down the left of the map (each stay with its times and length, and photos taken outside stays); tap a row to go there, and tap a stay to open its details below it. On a phone, tap a pin and a card appears under the map; tap the "Stayed at 3 places…" line in the strip to see the day as a list. Details show the place's name, its place name, each visit's times, the total time, and how many photos you took there. Unnamed places have **Name this place**, which takes you to **Frequent places** under Settings · Data sources · **Phone · Location**.
- **Turn it off**: **Footprints** at the top right of the title bar. Tap it and nothing is drawn; tap again and it's back (remembered in this device's browser).
- A footprint card in a chat opens this page on that day (even if **Footprints** was off).

Footprints are **drawn only inside ergo and never sent to any map service**: ergo on your computer works them out from what your phone sent, without going online. See "What map services can see" below.

## Map cards in chats

Tell ergo "show where I went today on a map" or "where did I go yesterday?" and it first sums it up in a sentence ("You went to 3 places: the office, West Lake and home"), then puts a **map card** in the chat. It works the same by voice: what's read to you is the summary, and the map is on the card.

- **Footprint card**: the title says which day ("Where you went on 11/6"), a small map below shows that day's track, stays and photo spots, and under it "Stayed at 3 places · 6 photos" and the places you went. The small map can't be dragged; tap it (or **Open map** at its top right) to see that day on the map page. The small map uses OpenStreetMap, just like the map page does for footprints.
- **Places and routes you looked up**: after ergo looks up "how do I get from the office to West Lake?" or "coffee shops nearby", it can put the result on a card. Results from AMap **can only be drawn on AMap's own map** (AMap's rule), so the card has no small map: it lists the ways to get there (walking, driving…) or the places found, and says **Data from AMap**; tap **View on AMap** to see it drawn on AMap on the map page. Without an AMap web key the map page can't draw it and says why. Results are kept on the computer only for a little while and never saved (AMap doesn't allow it), so after a while the card says they've expired; just ask again.
- **Points and routes ergo marks**: when it says "here are West Lake and Lingyin Temple" you get a card too, drawn like a footprint card.
- While the map page shows a card, the strip under the title bar shows the card's title; tap **×** to go back to your footprints.

A card only stores the date (footprints are fetched fresh each time you open it, so if they're deleted on the phone side they disappear from the card too), the lookup's ID, or the few points ergo gave.

## A clearer map inside China: enter an AMap key

Without a key, inside China the map uses OpenStreetMap too and says "Enter an AMap key for a clearer map inside China"; tap **Set up** to go where you enter it.

**Where:** Settings · Data and devices · Data sources, then **AMap**.

1. Register on the AMap Open Platform (lbs.amap.com), complete personal verification, and create an app in the console;
2. Add a key to the app with the platform **Web (JS API)**. Under the same key there's a **security code**;
3. Enter the key and the security code in **Web (JS API) key** and **Security code**, then tap **Test and save**. ergo asks AMap once with them (about a fixed point — Tiananmen in Beijing — not your location) and saves them only if AMap accepts;
4. **Web service key** is optional for now: you'll need it later for looking up places and routes. Create another key in the console with the platform **Web service**.

If something's wrong it says why: wrong key, wrong security code, or the wrong platform for the key. If a newly entered one fails, the previously saved one stays in use.

The keys and security code stay on this computer. The security code is never sent to the web page: for the AMap requests that need it, ergo adds it on the computer before forwarding them to AMap.

To stop using it: tap **Disconnect** under **AMap**; the keys are deleted from this computer and the map uses OpenStreetMap inside China.

## What map services can see

- **OpenStreetMap**: your computer fetches the map images for the page, so OpenStreetMap sees the computer's network address and the area you're looking at, not your phone's. Fetched images are kept on the computer for a while and not fetched again.
- **AMap**: for maps inside China, your browser fetches map data directly from AMap, so AMap sees this device's network address and the area you're looking at.
- **Where you went each day and where your photos were taken are never sent to any map service**: ergo on your computer works out your footprints, the page gets them only from ergo, and ergo doesn't send these points to OpenStreetMap, AMap or any other map service.
  - **Footprints are always shown on OpenStreetMap**: the page draws the points itself, they're never handed to AMap's map program, and that program isn't loaded for them (the small maps on footprint cards in chats too). AMap's map is drawn by AMap's program running in the page, which can see what it's asked to draw, so footprints are kept away from it. If this page already loaded AMap earlier (you looked at China with **Footprints** off, or at a route from AMap), its program is already in the page; footprints still aren't handed to it after you turn **Footprints** on, and reloading the page removes it completely.
  - The map itself still has to be fetched: when you look at a day's footprints the map moves to that area, so the map service knows you're looking at it (just like when you drag the map yourself).

## Turn the map off

Settings · Plugins, disable **Map**. While it's disabled, earlier map cards in chats say the Map plugin isn't enabled. Removing it with **Delete its data** deletes the AMap keys you entered, the map images stored on the computer and the map cards in chats.
