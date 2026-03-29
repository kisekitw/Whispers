import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

const config = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
admin.initializeApp({ projectId: config.projectId });
const db = getFirestore(config.firestoreDatabaseId);

async function test() {
  try {
    console.log("Testing users...");
    const users = await db.collection("users").get();
    console.log("Users:", users.size);
    console.log("Testing logs...");
    const logs = await db.collection("logs").limit(10).get();
    console.log("Logs:", logs.size);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
