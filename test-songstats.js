import "dotenv/config";

console.log("KEY EXISTS:", !!process.env.SONGSTATS_API_KEY);
console.log("KEY PREFIX:", process.env.SONGSTATS_API_KEY?.slice(0,4));