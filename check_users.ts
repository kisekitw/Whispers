import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function checkUsers() {
  const configPath = path.join(__dirname, "firebase-applet-config.json");
  const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  
  const usersSnapshot = await getDocs(collection(db, "users"));
  console.log("Total users found:", usersSnapshot.size);
  usersSnapshot.docs.forEach(d => {
    console.log("User ID:", d.id, "Data:", d.data());
  });
}

checkUsers().catch(console.error);
