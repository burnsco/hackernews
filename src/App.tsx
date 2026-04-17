import { Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import HackerNewsFrontPage from "./HackerNewsPage";
import { RootLayout } from "./RootLayout";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<RootLayout />}>
          <Route
            path="/"
            element={
              <Suspense fallback={<div className="min-h-screen bg-bg" />}>
                <HackerNewsFrontPage />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
