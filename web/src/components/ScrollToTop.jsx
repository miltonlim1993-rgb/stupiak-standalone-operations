import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const getHashId = (hash) => {
  const rawId = hash.slice(1);

  try {
    return decodeURIComponent(rawId);
  } catch {
    return rawId;
  }
};

export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === "POP") return;

    if (hash) {
      const id = getHashId(hash);
      const timer = window.setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
      }, 50);
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(() => {
      const scroller = document.querySelector('.chefops-main-scroll');
      scroller?.scrollTo({ top: 0, left: 0, behavior: "instant" });
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [pathname, hash, navigationType]);

  return null;
}
