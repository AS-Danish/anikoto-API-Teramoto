const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 OPR/133.0.0.0',
};

async function test() {
  try {
    const urlWithoutT = 'https://anikoto.net/filter?page=1';
    const res1 = await axios.get(urlWithoutT, { headers: DEFAULT_HEADERS });
    const $1 = cheerio.load(res1.data);
    console.log('--- Without _t: https://anikoto.net/filter?page=1 ---');
    $1('.film_list-wrap .flw-item .name, #list-items .item .name, .ani.items .item .name').slice(0, 5).each((i, el) => {
      console.log(i + 1, $1(el).text().trim());
    });

    const urlWithT = `https://anikoto.net/filter?page=1&_t=${Date.now()}`;
    const res2 = await axios.get(urlWithT, { headers: { ...DEFAULT_HEADERS, 'Cache-Control': 'no-cache, no-store' } });
    const $2 = cheerio.load(res2.data);
    console.log(`--- With _t & no-cache header: ${urlWithT} ---`);
    $2('.film_list-wrap .flw-item .name, #list-items .item .name, .ani.items .item .name').slice(0, 5).each((i, el) => {
      console.log(i + 1, $2(el).text().trim());
    });
  } catch (err) {
    console.error(err);
  }
}
test();
