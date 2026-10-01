import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html must provide a #root container");
}

createRoot(container).render(<App />);
