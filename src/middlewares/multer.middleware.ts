import multer from "multer";


    
const storage = multer.memoryStorage();

const upload = multer({ storage });

// For multiple files upload (e.g., product images)
export const uploadMultipleFiles = upload.array("files", 10);

// For single file upload (e.g., profile picture)
export const uploadSingleFile = upload.single("profile");