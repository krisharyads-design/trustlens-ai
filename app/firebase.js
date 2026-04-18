import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDJOvb8B9s71BM_8VSYguLQlq90RvX9Brs",
  authDomain: "trustlens-ai-ca048.firebaseapp.com",
  projectId: "trustlens-ai-ca048",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);