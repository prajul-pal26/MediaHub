document.getElementById("open-edit").onclick = () => {
  const tabs = globalThis.chrome?.tabs || globalThis.browser?.tabs;
  if (tabs) {
    tabs.create({ url: "https://www.instagram.com/accounts/edit/" });
  } else {
    window.open("https://www.instagram.com/accounts/edit/", "_blank");
  }
};

document.getElementById("open-mediahub").onclick = () => {
  const tabs = globalThis.chrome?.tabs || globalThis.browser?.tabs;
  if (tabs) {
    tabs.create({ url: "https://localhost:3443/insta-profile-photo" });
  } else {
    window.open("https://localhost:3443/insta-profile-photo", "_blank");
  }
};
