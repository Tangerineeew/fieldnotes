// The fictional library, trips and comments the README screenshots show, in English and in Simplified Chinese. Yunnan leads;
// Japan and Korea keep the library from being about one place.
const pid = () => Math.random().toString(36).slice(2, 10);
const options = (names) => names.map((name, color) => ({ id: pid(), name, color }));
const select = (name, chosen, all) => {
  const choices = options(all);
  return { id: pid(), name, type: 'select', value: choices.find((option) => option.name === chosen).id, options: choices };
};
const multi = (name, chosen, all) => {
  const choices = options(all);
  return { id: pid(), name, type: 'multi_select', value: choices.filter((option) => chosen.includes(option.name)).map((o) => o.id),
    options: choices };
};
const checklist = (name, items) => ({ id: pid(), name, type: 'checklist', value: items.map(([text, done]) => ({ text, done })) });
const url = (name, value) => ({ id: pid(), name, type: 'url', value });
const text = (name, value) => ({ id: pid(), name, type: 'text', value });
const number = (name, value) => ({ id: pid(), name, type: 'number', value });
const date = (name, value) => ({ id: pid(), name, type: 'date', value });

const CITIES = { en: ['Kunming', 'Dali', 'Lijiang', 'Tokyo', 'Kyoto', 'Seoul'], zh: ['昆明', '大理', '丽江', '东京', '京都', '首尔'] };
const STATUS = { en: ['Draft', 'Ready'], zh: ['草稿', '可用'] };
const TAGS = { en: ['Transit', 'Food', 'Nature', 'Culture', 'Money'], zh: ['交通', '美食', '自然', '文化', '花钱'] };
// Links, trips and trip folders are the same in both languages; only the words differ.
// Only Onsen etiquette is public: going public opens Japan above it, whose other notes keep it in the private library too.
const SHARED = {
  public: ['onsen'],
  collaborators: { rail: { 2: 'editor', 3: 'viewer', 4: 'viewer' }, esim: { 2: 'editor', 3: 'viewer', 4: 'viewer', 5: 'viewer' } },
  links: [['rail', 10, 103, 'live'], ['erhai', 10, 104, 'live'], ['alipay', 10, null, 'live'], ['esim', 10, null, 'live'],
    ['day1', 10, 101, 'snapshot'], ['stoneforest', 10, 102, 'live'], ['crossbridge', 10, 102, 'snapshot'], ['mushrooms', 10, null, 'live'],
    ['snow', 10, 105, 'snapshot'], ['altitude', 10, 105, 'live'], ['entry', 10, null, 'snapshot'], ['packing', 10, null, 'live'],
    ['esim', 20, null, 'snapshot'], ['seoul', 20, 201, 'live'], ['kyoto', 30, 301, 'live']],
  deleted: ['oldhostels', 'shangrila', 'airport'],
};

export const DEMO = {
  en: { ...SHARED,
    folders: {
      china: ['China', '🇨🇳'], yunnan: ['Yunnan', '⛰️', 'china'], kunming: ['Kunming', '🌸', 'yunnan'], dali: ['Dali', '🌊', 'yunnan'],
      lijiang: ['Lijiang', '🏮', 'yunnan'], japan: ['Japan', '🇯🇵'], tokyo: ['Tokyo', '🗼', 'japan'], kyoto: ['Kyoto', '⛩️', 'japan'],
      korea: ['Korea', '🇰🇷'], seoul: ['Seoul', '🏙️', 'korea'], food: ['Food', '🍜'], prep: ['Before you go', '🧭'],
    },
    notes: {
      erhai: { folder: 'dali', icon: '🚲', title: 'Cycling around Erhai',
        props: [select('City', 'Dali', CITIES.en), multi('Tags', ['Transit', 'Nature'], TAGS.en), text('Distance', 'About 120 km')],
        content: `## The loop

- The **west shore** is flat and busy; the **east shore** is quieter, with the better views of Cangshan.
- An e-bike does the whole loop in a long day; most people ride half and come back.
- At 2,000 m the sun burns faster than it feels.

> [!tip] Start early
> Leave Caicun before eight: the light on the lake is softest and the road is empty.

| Stop | From Caicun | Why |
| --- | --- | --- |
| Xizhou | 18 km | Baba bread, Bai courtyards |
| Shuanglang | 45 km | Lakeside cafés |
| Wase market | 52 km | Market days end in 5 and 0 |` },
      altitude: { folder: 'yunnan', icon: '🏔️', title: 'Altitude, step by step',
        props: [multi('Tags', ['Nature'], TAGS.en), text('Highest point', '4,680 m, Jade Dragon Snow Mountain')],
        content: `Kunming 1,900 m → Dali 2,000 m → Lijiang 2,400 m. Go up in that order and give each a night.

> [!warning] Snow mountain
> Buy a can of oxygen at the base and walk slowly at the top; turn back if your head starts to ache.` },
      mushrooms: { folder: 'yunnan', icon: '🍄', title: 'Wild mushrooms: what is safe',
        props: [multi('Tags', ['Food'], TAGS.en), select('Status', 'Ready', STATUS.en)],
        content: `Eat them in restaurants, cooked through, never from a market stall to cook yourself.

> [!danger] Jianshou qing
> Undercooked, it makes people see small people. Order it only where it is cooked in front of you.` },
      rail: { folder: 'yunnan', icon: '🚄', title: 'Getting around Yunnan',
        props: [multi('Cities', ['Kunming', 'Dali', 'Lijiang'], CITIES.en), select('Status', 'Ready', STATUS.en),
          multi('Tags', ['Transit'], TAGS.en),
          checklist('Before you go', [['Install the 12306 app', true], ['Add your passport to 12306', true],
            ['Book Dali → Lijiang', false]]), url('Tickets', 'https://www.12306.cn/en/')],
        content: `## Getting around

- **High-speed trains** link Kunming, Dali and Lijiang; book on 12306 with your passport.
- **Didi** works in every city, and Alipay pays for it.
- Buses to the Stone Forest leave Kunming East every 30 minutes.

> [!tip] Kunming South
> Allow 40 minutes from the city centre: the station is far out and security is thorough.

## Trains worth booking

| Route | Time | Fare |
| --- | --- | --- |
| Kunming South → Dali | 2 h | ¥145 |
| Dali → Lijiang | 1 h 20 | ¥70 |
| Kunming South → Lijiang | 3 h 20 | ¥215 |

Going further? See [[{erhai}|Cycling around Erhai]] and [[{altitude}|Altitude, step by step]].` },
      day1: { folder: 'kunming', icon: '🌸', title: 'Day 1: Kunming',
        content: `Land at Changshui, drop the bags at the hotel, then an easy evening by Green Lake.

![[trek:booking/71|Shanghai Pudong → Kunming Changshui]]
![[trek:stay/31|Cuihu Hotel]]

Walk down [[trek:place/602|Wenlin Street]] for dinner, then on to the old arches:

![[trek:place/601|Green Lake Park]]
![[trek:place/603|Golden Horse and Jade Rooster Arch]]

Tomorrow is the Stone Forest:

![[trek:day/102|Stone Forest]]` },
      crossbridge: { folder: 'kunming', icon: '🍜', title: 'Cross-bridge rice noodles',
        props: [select('City', 'Kunming', CITIES.en), number('Per bowl (¥)', 38), multi('Tags', ['Food'], TAGS.en)],
        content: 'The broth arrives boiling under a layer of oil: add the raw slices first, the noodles last, and wait before you sip.' },
      stoneforest: { folder: 'kunming', icon: '🪨', title: 'Stone Forest day trip',
        props: [select('City', 'Kunming', CITIES.en), date('Visit on', '2026-04-02'), text('Tickets', '¥130, book the day before')],
        content: 'The Major Stone Forest takes two hours on foot; the electric carts save the walk back.' },
      oldtown: { folder: 'dali', icon: '🏮', title: 'Dali Old Town after dark', props: [select('City', 'Dali', CITIES.en)],
        content: 'Renmin Road gets lively after nine; Foreigner Street is quieter for a drink.' },
      xizhou: { folder: 'dali', icon: '🏡', title: 'Xizhou and Shuanglang', props: [select('City', 'Dali', CITIES.en),
        multi('Tags', ['Culture'], TAGS.en)], content: 'Xizhou for Bai courtyards and baba bread; Shuanglang for the sunset.' },
      coffee: { folder: 'dali', icon: '☕', title: 'Coffee in Dali', props: [select('City', 'Dali', CITIES.en)],
        content: 'Yunnan grows most of China’s coffee; the roasters by the north gate open at eight.' },
      snow: { folder: 'lijiang', icon: '🏔️', title: 'Jade Dragon Snow Mountain',
        props: [select('City', 'Lijiang', CITIES.en), date('Visit on', '2026-04-05'), text('Tickets', 'Book the cable car 7 days ahead')],
        content: `## Plan the day

| Time | What |
| --- | --- |
| 07:00 | Bus from the old town |
| 08:00 | Big cable car to 4,506 m |
| 11:00 | Blue Moon Valley |

> [!warning] Altitude
> Walk slowly at the top; the boardwalk climbs another 170 m.` },
      shuhe: { folder: 'lijiang', icon: '🏘️', title: 'Lijiang Old Town and Shuhe', props: [select('City', 'Lijiang', CITIES.en)],
        content: 'Stay in Shuhe: the same canals and courtyards, a fraction of the crowds.' },
      alipay: { folder: 'china', icon: '📱', title: 'Paying with Alipay and WeChat', props: [multi('Tags', ['Money'], TAGS.en)],
        content: 'Both take foreign cards now. Keep ¥500 in cash for markets and the odd bus.' },
      beijing: { folder: 'china', icon: '🏯', title: 'Beijing in 48 hours', content: 'Forbidden City tickets open 7 days ahead, at 20:00.' },
      transit: { folder: 'tokyo', icon: '🚃', title: 'Tokyo transit cheat sheet', props: [select('City', 'Tokyo', CITIES.en)],
        content: 'Suica works on almost every train, bus and convenience store; tap in and out.' },
      kyoto: { folder: 'kyoto', icon: '⛩️', title: 'Kyoto temples: hours and tickets', props: [select('City', 'Kyoto', CITIES.en)],
        content: '| Temple | Opens | Ticket |\n| --- | --- | --- |\n| Kiyomizu-dera | 6:00 | ¥500 |\n| Kinkaku-ji | 9:00 | ¥500 |' },
      onsen: { folder: 'japan', icon: '♨️', title: 'Onsen etiquette', props: [multi('Tags', ['Culture'], TAGS.en)],
        content: 'Wash at the shower stools first, and keep the small towel out of the water.' },
      jrpass: { folder: 'japan', icon: '🚅', title: 'JR Pass or single tickets?', props: [multi('Tags', ['Transit', 'Money'], TAGS.en)],
        content: 'A 7-day pass pays off only with a Tokyo–Kyoto round trip and one more long ride.' },
      seoul: { folder: 'seoul', icon: '🚇', title: 'Seoul subway basics', props: [select('City', 'Seoul', CITIES.en)],
        content: 'T-money works on the subway, buses and taxis; transfers within 30 minutes are free.' },
      myeongdong: { folder: 'seoul', icon: '🍢', title: 'Myeongdong street food', props: [select('City', 'Seoul', CITIES.en)],
        content: 'Stalls open around five; the egg bread goes first.' },
      bai: { folder: 'food', icon: '🥘', title: 'Bai dishes to try', props: [multi('Tags', ['Food'], TAGS.en)],
        content: '- Rushan, fried milk fan\n- Erkuai, rice cake\n- Sour and spicy fish from Erhai' },
      entry: { folder: 'prep', icon: '🛂', title: 'Entry and visa-free transit',
        props: [checklist('Documents', [['Passport valid 6 months', true], ['Onward ticket printed', true],
          ['Hotel address in Chinese', false]])],
        content: 'Keep the hotel address in Chinese on your phone for taxis and check-in.' },
      packing: { folder: 'prep', icon: '🧳', title: 'Spring packing list',
        props: [checklist('Pack', [['Down vest for the snow mountain', true], ['Sunscreen SPF 50', true], ['Lip balm', false],
          ['Rain shell', true]])],
        content: 'Yunnan in April: warm days, cold nights, strong sun.' },
      esim: { folder: 'prep', icon: '📶', title: 'eSIM and Wi-Fi',
        props: [multi('Tags', ['Money'], TAGS.en), select('Status', 'Ready', STATUS.en)],
        content: 'Install the eSIM at home and switch it on after landing. 10 GB lasts a week of maps and messages.' },
      oldhostels: { folder: 'yunnan', icon: '🛏️', title: 'Lijiang hostels (old list)', content: 'Two near Sifang Street.' },
      shangrila: { folder: 'yunnan', icon: '🌄', title: 'Shangri-La day trip (draft)', content: 'Too far for one day; next time.' },
      airport: { folder: 'prep', icon: '🏨', title: 'Kunming airport hotel', content: 'Only if the flight lands after 22:00.' },
    },
    tripFolders: [['Getting around', '🚄', ['rail', 'erhai', 'alipay', 'esim']], ['Daily plans', '🗓️', ['day1', 'stoneforest']],
      ['Food', '🍜', ['crossbridge', 'mushrooms']], ['Before we go', '🧭', ['entry', 'packing']]],
    // note, author, text, quoted passage, what follows it, thread it answers, resolved
    comments: [
      ['rail', 2, 'Can we book Dali → Lijiang on the day?', 'High-speed trains', ' link Kunming'],
      ['rail', 3, 'Better not, the morning trains sell out in April.', null, null, 0],
      ['rail', 4, 'Booked four seats on the 9:40.', null, null, 0],
      ['rail', 5, 'Does Didi take foreign cards too?', 'Didi', ' works in every city'],
      ['rail', 2, 'Yes, through Alipay.', null, null, 3],
      ['rail', 3, 'Worth adding the metro to Kunming South.', 'Kunming South → Dali', null],
      ['rail', 4, 'Fixed the time from the centre.', 'Allow 40 minutes', null, null, true],
      ['day1', 5, 'Shall we book Jianxin Garden for night one?', 'an easy evening by Green Lake', null],
    ],
  },
  zh: { ...SHARED,
    folders: {
      china: ['中国', '🇨🇳'], yunnan: ['云南', '⛰️', 'china'], kunming: ['昆明', '🌸', 'yunnan'], dali: ['大理', '🌊', 'yunnan'],
      lijiang: ['丽江', '🏮', 'yunnan'], japan: ['日本', '🇯🇵'], tokyo: ['东京', '🗼', 'japan'], kyoto: ['京都', '⛩️', 'japan'],
      korea: ['韩国', '🇰🇷'], seoul: ['首尔', '🏙️', 'korea'], food: ['美食', '🍜'], prep: ['行前准备', '🧭'],
    },
    notes: {
      erhai: { folder: 'dali', icon: '🚲', title: '环洱海骑行',
        props: [select('城市', '大理', CITIES.zh), multi('标签', ['交通', '自然'], TAGS.zh), text('全程', '约 120 公里')],
        content: `## 环湖一圈

- **西岸**平坦，车多；**东岸**安静，看苍山的角度更好。
- 电动车一天能骑完一圈，多数人骑半圈再折返。
- 海拔两千米，太阳晒得比感觉的更狠。

> [!tip] 早点出发
> 八点前从才村出发：湖上的光最柔和，路上也没人。

| 停留点 | 距才村 | 看点 |
| --- | --- | --- |
| 喜洲 | 18 公里 | 喜洲粑粑、白族院落 |
| 双廊 | 45 公里 | 湖边咖啡馆 |
| 挖色集市 | 52 公里 | 逢五逢十赶集 |` },
      altitude: { folder: 'yunnan', icon: '🏔️', title: '海拔，一步一步来',
        props: [multi('标签', ['自然'], TAGS.zh), text('最高点', '4,680 米，玉龙雪山')],
        content: `昆明 1,900 米 → 大理 2,000 米 → 丽江 2,400 米。按这个顺序走，每地住一晚再往上。

> [!warning] 雪山
> 山下买一罐氧气，山顶慢慢走；一旦头疼就往回撤。` },
      mushrooms: { folder: 'yunnan', icon: '🍄', title: '野生菌：怎样吃才安全',
        props: [multi('标签', ['美食'], TAGS.zh), select('状态', '可用', STATUS.zh)],
        content: `在餐馆吃、彻底煮熟，不要从市场买回去自己做。

> [!danger] 见手青
> 没熟透会让人"看见小人"。只在当着你的面煮的店里点。` },
      rail: { folder: 'yunnan', icon: '🚄', title: '云南交通速查',
        props: [multi('城市', ['昆明', '大理', '丽江'], CITIES.zh), select('状态', '可用', STATUS.zh), multi('标签', ['交通'], TAGS.zh),
          checklist('出发前', [['安装 12306', true], ['在 12306 添加证件', true], ['订大理 → 丽江', false]]),
          url('购票', 'https://www.12306.cn/')],
        content: `## 怎么走

- **动车**连接昆明、大理和丽江；在 12306 用证件购票。
- **滴滴**每座城市都能打，支付宝就能付。
- 去石林的大巴每 30 分钟一班，从昆明东站发车。

> [!tip] 昆明南站
> 从市中心过去留出 40 分钟：车站很远，安检也仔细。

## 值得订的车次

| 线路 | 用时 | 票价 |
| --- | --- | --- |
| 昆明南 → 大理 | 2 小时 | 145 元 |
| 大理 → 丽江 | 1 小时 20 分 | 70 元 |
| 昆明南 → 丽江 | 3 小时 20 分 | 215 元 |

要去更远的地方，见 [[{erhai}|环洱海骑行]] 和 [[{altitude}|海拔，一步一步来]]。` },
      day1: { folder: 'kunming', icon: '🌸', title: '第一天：昆明',
        content: `长水落地，先去酒店放行李，傍晚在翠湖边轻松走走。

![[trek:booking/71|上海浦东 → 昆明长水]]
![[trek:stay/31|翠湖宾馆]]

沿 [[trek:place/602|文林街]] 吃晚饭，再去看老牌坊：

![[trek:place/601|翠湖公园]]
![[trek:place/603|金马碧鸡坊]]

第二天去石林：

![[trek:day/102|石林一日]]` },
      crossbridge: { folder: 'kunming', icon: '🍜', title: '过桥米线怎么吃',
        props: [select('城市', '昆明', CITIES.zh), number('每碗（元）', 38), multi('标签', ['美食'], TAGS.zh)],
        content: '汤端上来时盖着一层油，还在滚：先下生片，最后下米线，别急着喝汤。' },
      stoneforest: { folder: 'kunming', icon: '🪨', title: '石林一日游',
        props: [select('城市', '昆明', CITIES.zh), date('计划日期', '2026-04-02'), text('门票', '130 元，提前一天订')],
        content: '大石林步行约两小时；回程坐电瓶车省点力气。' },
      oldtown: { folder: 'dali', icon: '🏮', title: '夜游大理古城', props: [select('城市', '大理', CITIES.zh)],
        content: '人民路九点后最热闹；想安静喝一杯就去洋人街。' },
      xizhou: { folder: 'dali', icon: '🏡', title: '喜洲与双廊', props: [select('城市', '大理', CITIES.zh), multi('标签', ['文化'], TAGS.zh)],
        content: '喜洲看白族院落、吃粑粑；双廊看日落。' },
      coffee: { folder: 'dali', icon: '☕', title: '大理的咖啡', props: [select('城市', '大理', CITIES.zh)],
        content: '中国大部分咖啡产自云南；北门附近的烘焙店八点开门。' },
      snow: { folder: 'lijiang', icon: '🏔️', title: '玉龙雪山',
        props: [select('城市', '丽江', CITIES.zh), date('计划日期', '2026-04-05'), text('门票', '大索道提前 7 天订')],
        content: `## 一天的安排

| 时间 | 安排 |
| --- | --- |
| 07:00 | 古城坐大巴出发 |
| 08:00 | 大索道上到 4,506 米 |
| 11:00 | 蓝月谷 |

> [!warning] 海拔
> 山顶慢慢走，栈道还要再爬 170 米。` },
      shuhe: { folder: 'lijiang', icon: '🏘️', title: '丽江古城与束河', props: [select('城市', '丽江', CITIES.zh)],
        content: '住束河：一样的水渠和院子，人少很多。' },
      alipay: { folder: 'china', icon: '📱', title: '用支付宝和微信付款', props: [multi('标签', ['花钱'], TAGS.zh)],
        content: '两者现在都能绑境外卡。身上留 500 元现金，应付集市和偶尔的公交。' },
      beijing: { folder: 'china', icon: '🏯', title: '北京 48 小时', content: '故宫门票提前 7 天、晚上 8 点放票。' },
      transit: { folder: 'tokyo', icon: '🚃', title: '东京交通速查', props: [select('城市', '东京', CITIES.zh)],
        content: 'Suica 几乎能坐所有电车、公交，也能在便利店付款；进出站都要刷。' },
      kyoto: { folder: 'kyoto', icon: '⛩️', title: '京都寺院：开放时间与门票', props: [select('城市', '京都', CITIES.zh)],
        content: '| 寺院 | 开门 | 门票 |\n| --- | --- | --- |\n| 清水寺 | 6:00 | 500 日元 |\n| 金阁寺 | 9:00 | 500 日元 |' },
      onsen: { folder: 'japan', icon: '♨️', title: '温泉礼仪', props: [multi('标签', ['文化'], TAGS.zh)],
        content: '先坐在淋浴凳上洗干净，小毛巾不要放进池水里。' },
      jrpass: { folder: 'japan', icon: '🚅', title: 'JR Pass 还是单程票？', props: [multi('标签', ['交通', '花钱'], TAGS.zh)],
        content: '7 日券只有在东京—京都往返之外还有一段长途时才划算。' },
      seoul: { folder: 'seoul', icon: '🚇', title: '首尔地铁入门', props: [select('城市', '首尔', CITIES.zh)],
        content: 'T-money 能坐地铁、公交和出租车，30 分钟内换乘免费。' },
      myeongdong: { folder: 'seoul', icon: '🍢', title: '明洞小吃', props: [select('城市', '首尔', CITIES.zh)],
        content: '摊位五点左右出摊，鸡蛋糕最先卖完。' },
      bai: { folder: 'food', icon: '🥘', title: '白族菜清单', props: [multi('标签', ['美食'], TAGS.zh)],
        content: '- 乳扇\n- 饵块\n- 洱海酸辣鱼' },
      entry: { folder: 'prep', icon: '🛂', title: '入境与免签过境',
        props: [checklist('证件', [['护照有效期 6 个月以上', true], ['打印好联程机票', true], ['酒店中文地址', false]])],
        content: '手机里存好酒店的中文地址，打车和入住都用得上。' },
      packing: { folder: 'prep', icon: '🧳', title: '春季行李清单',
        props: [checklist('要带', [['上雪山的羽绒背心', true], ['SPF 50 防晒', true], ['润唇膏', false], ['防雨外套', true]])],
        content: '四月的云南：白天暖，晚上冷，太阳很晒。' },
      esim: { folder: 'prep', icon: '📶', title: 'eSIM 与 Wi-Fi', props: [multi('标签', ['花钱'], TAGS.zh), select('状态', '可用', STATUS.zh)],
        content: '在家装好 eSIM，落地后再打开。10 GB 够一周的地图和聊天。' },
      oldhostels: { folder: 'yunnan', icon: '🛏️', title: '丽江青旅（旧清单）', content: '四方街附近两家。' },
      shangrila: { folder: 'yunnan', icon: '🌄', title: '香格里拉一日游（草稿）', content: '一天太赶，下次再去。' },
      airport: { folder: 'prep', icon: '🏨', title: '昆明机场酒店', content: '只有航班在 22 点后落地时才需要。' },
    },
    tripFolders: [['交通', '🚄', ['rail', 'erhai', 'alipay', 'esim']], ['每日计划', '🗓️', ['day1', 'stoneforest']],
      ['美食', '🍜', ['crossbridge', 'mushrooms']], ['行前准备', '🧭', ['entry', 'packing']]],
    comments: [
      ['rail', 2, '大理到丽江可以当天买票吗？', '动车', '连接昆明'],
      ['rail', 3, '最好别，四月早上的车都会卖光。', null, null, 0],
      ['rail', 4, '已经订好 9:40 那班的四个座位。', null, null, 0],
      ['rail', 5, '滴滴能绑境外卡吗？', '滴滴', '每座城市都能打'],
      ['rail', 2, '可以，通过支付宝付。', null, null, 3],
      ['rail', 3, '可以补上去昆明南站的地铁。', '昆明南 → 大理', null],
      ['rail', 4, '市中心过去的时间已经改好了。', '40 分钟', null, null, true],
      ['day1', 5, '第一晚要不要订建新园？', '傍晚在翠湖边轻松走走', null],
    ],
  },
};
