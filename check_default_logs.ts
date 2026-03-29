import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function checkDefaultLogs() {
  try {
    const configPath = path.join(__dirname, "firebase-applet-config.json");
    if (!fs.existsSync(configPath)) {
      console.error("firebase-applet-config.json not found");
      return;
    }
    const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    
    const app = initializeApp(firebaseConfig);
    // Force default database
    const db = getFirestore(app);

    console.log("Fetching logs from DEFAULT Firestore database...");
    const q = query(collection(db, "logs"), orderBy("timestamp", "desc"), limit(5));
    const snapshot = await getDocs(q);
    
    console.log(`Found ${snapshot.size} logs in DEFAULT database.`);
    snapshot.forEach(doc => {
      console.log(`- [${doc.data().timestamp}] ${doc.data().status}: ${doc.data().action} (User: ${doc.data().userId})`);
    });
  } catch (error) {
    console.error("Error checking default logs:", error);
  }
}

checkDefaultLogs();
