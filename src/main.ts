import { createApp } from "vue";
import { createPinia } from "pinia";
import {
  ElAlert,
  ElButton,
  ElButtonGroup,
  ElCheckbox,
  ElConfigProvider,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElInputNumber,
  ElOption,
  ElProgress,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSlider,
} from "element-plus";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import "./style.css";
import { i18n } from "./i18n";

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(i18n);

// Register only components used by the application; the global Element Plus
// installer pulls every component into the desktop startup bundle.
for (const component of [
  ElAlert,
  ElButton,
  ElButtonGroup,
  ElCheckbox,
  ElConfigProvider,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElInputNumber,
  ElOption,
  ElProgress,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSlider,
]) {
  app.component(component.name!, component);
}

app.mount("#app");
