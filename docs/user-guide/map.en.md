# Maps

ergo has a map: AMap inside mainland China, OpenStreetMap abroad (say, in Singapore), switching automatically as you look around. Later, the places you've been, places mentioned in chats, and routes you looked up will be drawn on this map.

After this chapter you'll know where the map page is, how to get a clearer map inside China (enter an AMap key), and what map services can see.

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
4. **Web service key** is optional for now: you'll need it later for looking up places and routes. Create another key in the console with the platform **Web service**.

If something's wrong it says why: wrong key, wrong security code, or the wrong platform for the key. If a newly entered one fails, the previously saved one stays in use.

The keys and security code stay on this computer. The security code is never sent to the web page: for the AMap requests that need it, ergo adds it on the computer before forwarding them to AMap.

To stop using it: tap **Disconnect** under **AMap**; the keys are deleted from this computer and the map uses OpenStreetMap inside China.

## What map services can see

- **OpenStreetMap**: your computer fetches the map images for the page, so OpenStreetMap sees the computer's network address and the area you're looking at, not your phone's. Fetched images are kept on the computer for a while and not fetched again.
- **AMap**: for maps inside China, your browser fetches map data directly from AMap, so AMap sees this device's network address and the area you're looking at.
- **Where you went each day and where your photos were taken are never sent to any map service**: your footprints, when they're drawn later, are drawn only inside ergo.

## Turn the map off

Settings · Plugins, disable **Map**. Removing it with **Delete its data** deletes the AMap keys you entered and the map images stored on the computer.
