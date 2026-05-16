import fs from "fs";

const LOG_FILE = "./songstats-usage-log.json";
const COST_PER_REQUEST = 0.01;

function readJson(file, fallback = []) {
  if (!fs.existsSync(file)) return fallback;

  const content = fs.readFileSync(file, "utf8").trim();

  if (!content) return fallback;

  return JSON.parse(content);
}

function formatMonth(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `${year}-${month}`;
}

const logs = readJson(LOG_FILE, []);

const now = new Date();

const currentMonth = formatMonth(now);

const previousDate = new Date();
previousDate.setMonth(previousDate.getMonth() - 1);

const previousMonth = formatMonth(previousDate);

const total = logs.length;

const currentMonthTotal = logs.filter(
  (x) => x.month === currentMonth
).length;

const previousMonthTotal = logs.filter(
  (x) => x.month === previousMonth
).length;

console.log("");
console.log("📊 Songstats usage report");
console.log("========================");
console.log(
  `Depuis le début : ${total} requêtes (${(
    total * COST_PER_REQUEST
  ).toFixed(2)} €)`
);

console.log(
  `Mois en cours (${currentMonth}) : ${currentMonthTotal} requêtes (${(
    currentMonthTotal * COST_PER_REQUEST
  ).toFixed(2)} €)`
);

console.log(
  `Mois précédent (${previousMonth}) : ${previousMonthTotal} requêtes (${(
    previousMonthTotal * COST_PER_REQUEST
  ).toFixed(2)} €)`
);

console.log("");