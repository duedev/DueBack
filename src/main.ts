import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./ui/theme.css";
import { mount } from "svelte";
import App from "./ui/App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app root element missing");
target.removeAttribute("aria-busy");

mount(App, { target });
