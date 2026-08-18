const SUPABASE_URL = "https://dffcmunbsoyajvudnfyl.supabase.co";

const SUPABASE_KEY = "sb_publishable_e1yF6jOZNKaOIhsnxbcmKQ_7nYOOKiu";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

console.log("Culture Archive connected to Supabase");

const showFormButton = document.getElementById("show-form-button");
const uploadForm = document.getElementById("upload-form");

showFormButton.addEventListener("click", () => {
  uploadForm.style.display = "block";
});
