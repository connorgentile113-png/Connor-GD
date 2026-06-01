module.exports = (req, res) => {
  res.json({
    message: "Hello from Node.js on Vercel!",
    time: new Date().toISOString()
  });
};
