# Maps

ergo has a map: AMap inside mainland China, OpenStreetMap abroad (say, in Singapore), switching automatically as you look around. You can also just ask ergo "how long from home to the office?" or "any coffee shops nearby?" and it looks it up on AMap for you. Later, the places you've been, places mentioned in chats, and routes you looked up will be drawn on this map.

After this chapter you'll know where the map page is, how to get a clearer map inside China (enter an AMap key), how to have ergo look up places and routes, and what map services can see.

## Open the map

**Where:** **Map** in the navigation. On a phone, it's under **More** when there's no room.

- Drag to move, pinch (scroll wheel on a computer) to zoom, double-tap to zoom in one level; the buttons at the top right zoom in and out too.
- The top left says which map is in use: **AMap** or **OpenStreetMap**.
- When you stop moving, ergo picks: inside mainland China with an AMap key, AMap; abroad, and in Hong Kong, Macau and Taiwan, OpenStreetMap.
- Next time it opens where you last looked (remembered in this device's browser).
- With OpenStreetMap, the bottom right says "© OpenStreetMap contributors"; AMap prints its own logo and map approval number in a corner.
- With the dark appearance, the map is dark too.

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

## Have ergo look up places and routes

Once the **Web service key** is in, just ask ergo:

- "How long from home to the office?": how long by car (AMap's estimate) and which roads are jammed, how long by bus or subway, where to change and the fare;
- "Any coffee shops nearby?", "What's to eat near the office?": names, addresses and distances, nearest first;
- "Where's Xixi Wetland?", "How do I get to Xixi Wetland?", "Where am I now?"

ergo says "data from AMap" in its answers. Results are looked up on the spot and used right away: not saved, not added to memory.

**Where "home" and "the office" are:** the names you gave under **Frequent places** in Settings · Data sources · Phone · Location. If you haven't named them yet, ergo tells you where to do it, or you can just give an address.

**Where "nearby" or "here" is:** the latest location the ergo app on your phone sent (start recording location in the app). If that location is a few hours old, ergo mentions that you may have moved on.

**Test lookup:** with the Web service key saved under **AMap**, tap **Run a test lookup**: ergo searches "Tiananmen" in Beijing once (a fixed word, not your location) and lists what it found, so you can see whether it works. Below it shows how many lookups you've made this month.

**Usage:** AMap's free quota for verified individual developers is roughly 5,000 place searches and 150,000 address and route lookups a month, free for one year; the AMap console has the real numbers. ergo counts lookups per month (only the counts, not what was looked up) and Settings · Checkup warns you when you're getting close. When AMap says the limit is reached, lookups are too frequent, or the key is wrong, ergo tells you so; for a wrong key the **AMap** row says it needs authorization — enter the key again.

For now it only looks up places and routes inside mainland China; lookups abroad will use the free OpenStreetMap services later.

## What map services can see

- **OpenStreetMap**: your computer fetches the map images for the page, so OpenStreetMap sees the computer's network address and the area you're looking at, not your phone's. Fetched images are kept on the computer for a while and not fetched again.
- **AMap**: for maps inside China, your browser fetches map data directly from AMap, so AMap sees this device's network address and the area you're looking at.
- **When looking up places and routes**: only when you ask, the start, the destination or the "nearby" spot for that one lookup goes to AMap ("home" and "the office" send the center of the place you named; "nearby" sends the one latest location from your phone).
- **Where you went each day and where your photos were taken are never sent to any map service**: your footprints, when they're drawn later, are drawn only inside ergo.

## Turn the map off

Settings · Plugins, disable **Map**. Removing it with **Delete its data** deletes the AMap keys you entered, the map images stored on the computer and the monthly lookup counts. To only stop ergo from looking things up, turn off **On-demand lookup** under **AMap**.
