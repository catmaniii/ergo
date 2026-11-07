# Maps

ergo has a map: AMap inside mainland China, OpenStreetMap abroad (say, in Singapore), switching automatically as you look around. Where you went on a given day, how long you stayed and where you took photos can be drawn on it; later, places mentioned in chats and routes you looked up will be drawn here too.

After this chapter you'll know where the map page is, how to see a day's footprints, how to get a clearer map inside China (enter an AMap key), and what map services can see.

## Open the map

**Where:** **Map** in the navigation. On a phone, it's under **More** when there's no room.

- Drag to move, pinch (scroll wheel on a computer) to zoom, double-tap to zoom in one level; the buttons at the top right zoom in and out too.
- The top left says which map is in use: **AMap** or **OpenStreetMap**.
- When you stop moving, ergo picks: inside mainland China with an AMap key, AMap; abroad, and in Hong Kong, Macau and Taiwan, OpenStreetMap.
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
- Footprint cards in chats (coming later) open this page on that day.

Footprints are **drawn only inside ergo and never sent to any map service**: ergo on your computer works them out from what your phone sent, without going online. See "What map services can see" below.

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
  - On OpenStreetMap the page draws the points itself. On AMap, the points are handed to AMap's map program running in the page, which draws them on your device. ergo doesn't send them to AMap, but that program is AMap's and can see what it's asked to draw (we found nothing showing it sends them back, but we can't check it line by line). If that bothers you, leave the AMap key empty so the map inside China uses OpenStreetMap too.
  - The map itself still has to be fetched: when you look at a day's footprints the map moves to that area, so the map service knows you're looking at it (just like when you drag the map yourself).

## Turn the map off

Settings · Plugins, disable **Map**. Removing it with **Delete its data** deletes the AMap keys you entered and the map images stored on the computer.
