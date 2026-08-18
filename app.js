const SUPABASE_URL = "https://dffcmunbsoyajvudnfyl.supabase.co";

const SUPABASE_KEY = "sb_publishable_e1yF6jOZNKaOIhsnxbcmKQ_7nYOOKiu";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

console.log("Culture Archive connected to Supabase");

const showFormButton = document.getElementById("show-form-button");
const uploadForm = document.getElementById("upload-form");
const saveItemButton = document.getElementById("save-item-button");

showFormButton.addEventListener("click", () => {
  uploadForm.style.display = "block";
});

saveItemButton.addEventListener("click", async () => {
  const title = document.getElementById("item-title").value.trim();
  const contentType = document.getElementById("item-type").value;
  const description = document.getElementById("item-description").value.trim();
  const fileInput = document.getElementById("item-file");

  if (!title) {
    alert("Please enter a title.");
    return;
  }

  if (!fileInput.files.length) {
    alert("Please choose a file.");
    return;
  }

  const file = fileInput.files[0];

  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = `${Date.now()}_${safeFileName}`;

  saveItemButton.disabled = true;
  saveItemButton.textContent = "Uploading...";

  try {
    const { error: uploadError } = await supabaseClient.storage
      .from("media")
      .upload(filePath, file);

    if (uploadError) {
      throw uploadError;
    }

    const { error: databaseError } = await supabaseClient
      .from("media_items")
      .insert({
        title: title,
        description: description,
        content_type: contentType,
        file_path: filePath
      });

    if (databaseError) {
      throw databaseError;
    }

    alert("Item added to Culture Archive!");

    document.getElementById("item-title").value = "";
    document.getElementById("item-description").value = "";
    document.getElementById("item-file").value = "";

    uploadForm.style.display = "none";

  } catch (error) {
    console.error(error);
    alert("Something went wrong: " + error.message);
  }

  saveItemButton.disabled = false;
  saveItemButton.textContent = "Add to Archive";
});
