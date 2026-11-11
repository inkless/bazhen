export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 72],
    // Bodies and trailers carry Control: lines and wrapped prose; only the subject has a budget.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
