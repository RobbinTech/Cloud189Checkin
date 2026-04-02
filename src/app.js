require("dotenv").config();
const {
  CloudClient,
  FileTokenStore,
  logger: sdkLogger,
} = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const fs = require("fs");
const tokenDir = ".token";

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const result = await cloudClient.userSign()
  const netdiskBonus = result.isSign? 0: result.netdiskBonus
  logger.info(`个人签到任务: 获得 ${netdiskBonus}M 空间`);
};

const run = async (userName, password, userSizeInfoMap, logger) => {
  if (!(userName && password)) return;

  const before = Date.now();
  const tokenPath = `${tokenDir}/${userName}.json`;

  const attempt = async () => {
    const cloudClient = new CloudClient({
      username: userName,
      password,
      token: new FileTokenStore(tokenPath),
    });

    const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();

    userSizeInfoMap.set(userName, {
      cloudClient,
      userSizeInfo: beforeUserSizeInfo,
      logger,
    });

    await doUserTask(cloudClient, logger);
  };

  try {
    logger.log("开始执行");

    // 第一次：用缓存 token
    await attempt();

  } catch (e) {
    const msg = String(e.message || "");

    logger.error(e);

    // 只针对 session 问题处理
    if (msg.includes("Can not get session")) {
      logger.warn("session 获取失败，删除 token 重试");

      try {
        if (fs.existsSync(tokenPath)) {
          fs.unlinkSync(tokenPath);
        }
      } catch (err) {
        logger.error("删除 token 失败", err);
      }

      // 第二次：强制重新登录
      await attempt();
    } else {
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    }

  } finally {
    logger.log(
      `执行完毕, 耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
    );
  }
};

// 开始执行程序
async function main() {
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    await run(userName, password, userSizeInfoMap, logger);
  }

  //数据汇总
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
    const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
    logger.log(
      `个人容量：⬆️  ${(
        (afterUserSizeInfo.cloudCapacityInfo.totalSize -
          userSizeInfo.cloudCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.cloudCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`,
      `家庭容量：⬆️  ${(
        (afterUserSizeInfo.familyCapacityInfo.totalSize -
          userSizeInfo.familyCapacityInfo.totalSize) /
        1024 /
        1024
      ).toFixed(2)}M/${(
        afterUserSizeInfo.familyCapacityInfo.totalSize /
        1024 /
        1024 /
        1024
      ).toFixed(2)}G`
    );
  }
}

(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    const logs = catLogs();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push("天翼云盘自动签到任务", logs + content);
    recording.erase();
    cleanLogs();
  }
})();
