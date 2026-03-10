try {
  require("./dist/index.js");
} catch (err) {
  console.error(
    "[boot] Failed to load compiled bot from dist/index.js. Did you run `npm run build`?",
    err
  );
  process.exit(1);
}
