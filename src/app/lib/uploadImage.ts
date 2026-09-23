import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 15000;

export class ImageValidationError extends Error {}

function validateImage(file: File): void {
  if (!file.type.startsWith("image/")) {
    throw new ImageValidationError("Bitte eine Bilddatei auswählen.");
  }
  // HEIC/HEIF (Standardformat der Fotos-App auf iPhone/Mac) lässt sich zwar
  // problemlos hochladen, aber Chrome/Firefox können es in einem <img>-Tag
  // nicht decodieren — das Bild würde danach dauerhaft als "nicht ladbar"
  // erscheinen. Deshalb hier schon vor dem Upload ablehnen statt erst beim
  // gescheiterten Anzeigen.
  if (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    /\.(heic|heif)$/i.test(file.name)
  ) {
    throw new ImageValidationError(
      "HEIC/HEIF-Bilder werden von Browsern nicht unterstützt. Bitte als JPG oder PNG exportieren."
    );
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new ImageValidationError(
      `Datei zu groß (max. ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB).`
    );
  }
}

// Hartes Timeout nötig: `uploadBytes` retried intern unbegrenzt bei
// dauerhaften Netzwerk-/CORS-Problemen, statt zeitnah abzulehnen — ohne
// dieses Timeout bliebe die UI unbegrenzt auf "Wird hochgeladen…" hängen.
export async function uploadImage(file: File, path: string): Promise<string> {
  validateImage(file);

  const storage = getStorage();
  const ref = storageRef(storage, path);

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            "Hochladen dauert zu lange — evtl. Netzwerk- oder Serverproblem."
          )
        ),
      UPLOAD_TIMEOUT_MS
    );
  });

  await Promise.race([uploadBytes(ref, file), timeout]);
  return Promise.race([getDownloadURL(ref), timeout]);
}
