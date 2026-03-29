import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import fs from "fs";

const config = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function test() {
  try {
    console.log("Testing users...");
    const users = await getDocs(collection(db, "users"));
    console.log("Users:", users.size);
    console.log("Testing logs...");
    const logs = await getDocs(query(collection(db, "logs"), orderBy("timestamp", "desc"), limit(10)));
    console.log("Logs:", logs.size);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
