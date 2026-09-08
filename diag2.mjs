import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getDatabase, ref, get } from "firebase/database";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
  })
);
const app = initializeApp({
  apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
});
const auth = getAuth(app);
const db = getDatabase(app);
const unameSnap = await get(ref(db, "usernames/lena_hoffmann"));
await signInWithEmailAndPassword(auth, unameSnap.val().email, "DemoPass123!");

const uids = {
  Christian: "cLMyWPf8NKQHVhlLTj6NdbUl7Ix1",
  ChrisTest: "CzaaEHKJkrQqVfLD90vdtSAETQJ3",
};
for (const [name, uid] of Object.entries(uids)) {
  const pk = (await get(ref(db, `publicKeys/${uid}`))).val();
  console.log(`${name}: keyVersion=${pk?.keyVersion}`);
}

const nuSnap = await get(ref(db, "newusers"));
const nu = nuSnap.val() || {};
console.log("\nAlle Usernames aktuell:", Object.entries(nu).map(([uid,u]) => `${u.username} (${uid})`));
