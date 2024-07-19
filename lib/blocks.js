'use strict';

var async = require('async');
var dashcore = require('@dashevo/dashcore-lib');
var _ = dashcore.deps._;
var pools = require('../pools.json');
var BN = dashcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function BlockController(options) {
  var self = this;
  this.node = options.node;

  this.blockSummaryCache = new LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
  this.blockCacheConfirmations = 6;
  this.blockCache = new LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);

  this.poolStrings = {};
  pools.forEach(function(pool) {
    pool.searchStrings.forEach(function(s) {
      self.poolStrings[s] = {
        poolName: pool.poolName,
        url: pool.url
      };
    });
  });

  this.common = new Common({log: this.node.log});
}

var BLOCK_LIMIT = 200;

BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000;
BlockController.DEFAULT_BLOCK_CACHE_SIZE = 1000;

function isHexadecimal(hash) {
  if (!_.isString(hash)) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(hash);
}

BlockController.prototype.checkBlockHash = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  if (hash.length < 64 || !isHexadecimal(hash)) {
    this.node.services.dashd.getBlockHeader(parseInt(hash), function(err, info) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      req.params.blockHash = info.hash;
      next();
    });
  } else {
    next();
  }
};

/**
 * Find block header by hash ...
 */
BlockController.prototype.blockHeader = function(req, res, next) {
	var self = this;
	var hash = req.params.blockHash;

	self.node.services.dashd.getBlockHeader(hash, function(err, info) {
		if (err) {
			return self.common.handleErrors(err, res);
		}
		req.blockHeader = info;
		next();
	});
};

/**
 * Retrieve an array of blockHeaders from a starting hash point
 * By default (i.e no nbOfBlock specified) it will return only 25 blocks
 */
BlockController.prototype.blockHeaders = function(req, res, next) {
	var self = this;
	var blockIdentifier = req.params.blockIdentifier;
	var nbOfBlockToFetch = ((req.params.hasOwnProperty('nbOfBlock')) ? (parseInt(req.params.nbOfBlock)>0 && parseInt(req.params.nbOfBlock) || false) : false) || 25;
	var cb = function(err, headers) {
		if (err) {
			return self.common.handleErrors(err, res);
		}
		else{
			res.jsonp({headers:headers});
		}
	};

	if(blockIdentifier.length===64){
		var hash = blockIdentifier;
		var result = self.node.services.dashd.getBlockHeaders(hash, cb, nbOfBlockToFetch);
	}else{
		var height = blockIdentifier;
		var result = self.node.services.dashd.getBlockHeaders(height, cb, nbOfBlockToFetch);
	}

};

/**
 * Find block by hash ...
 */
BlockController.prototype.block = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  var blockCached = self.blockCache.get(hash);

  if (blockCached) {
    blockCached.confirmations = self.node.services.dashd.height - blockCached.height + 1;
    req.block = blockCached;
    next();
  } else {
    self.node.getBlock(hash, function(err, block) {
      if((err && err.code === -5) || (err && err.code === -8)) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }
      self.node.services.dashd.getBlockHeader(hash, function(err, info) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        var blockResult = self.transformBlock(block, info);
        self.getBlockReward(blockResult.previousblockhash, function(err,reward) {
          if (err) {
            return self.common.handleErrors(err, res);
          }
          blockResult.reward = reward;

          if (blockResult.confirmations >= self.blockCacheConfirmations) {
            self.blockCache.set(hash, blockResult);
          }
          req.block = blockResult;
          next();
        });
      });
    });
  }
};

/**
 * Find rawblock by hash and height...
 */
BlockController.prototype.rawBlock = function(req, res, next) {
  var self = this;
  var blockHash = req.params.blockHash;

  self.node.getRawBlock(blockHash, function(err, blockBuffer) {
    if((err && err.code === -5) || (err && err.code === -8)) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }
    req.rawBlock = {
      rawblock: blockBuffer.toString('hex')
    };
    next();
  });

};

BlockController.prototype._normalizePrevHash = function(hash) {
  // TODO fix dashcore to give back null instead of null hash
  if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
    return hash;
  } else {
    return null;
  }
};

BlockController.prototype.transformBlock = function(block, info) {
  var blockObj = block.toObject();
  var transactionIds = blockObj.transactions.map(function(tx) {
    return tx.hash;
  });
  return {
    hash: block.hash,
    size: block.toBuffer().length,
    height: info.height,
    version: blockObj.header.version,
    merkleroot: blockObj.header.merkleRoot,
    tx: transactionIds,
    time: blockObj.header.time,
    nonce: blockObj.header.nonce,
    bits: blockObj.header.bits.toString(16),
    difficulty: parseFloat(info.difficulty),
    chainwork: info.chainWork,
    confirmations: info.confirmations,
    previousblockhash: this._normalizePrevHash(blockObj.header.prevHash),
    nextblockhash: info.nextHash,
    reward: null,
    isMainChain: (info.confirmations !== -1),
    poolInfo: this.getPoolInfo(block)
  };
};

/**
 * Show block
 */
BlockController.prototype.show = function(req, res) {
  if (req.block) {
    res.jsonp(req.block);
  }
};

BlockController.prototype.showRaw = function(req, res) {
  if (req.rawBlock) {
    res.jsonp(req.rawBlock);
  }
};

BlockController.prototype.blockIndex = function(req, res) {
  var self = this;
  var height = req.params.height;
  this.node.services.dashd.getBlockHeader(parseInt(height), function(err, info) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    res.jsonp({
      blockHash: info.hash
    });
  });
};

BlockController.prototype._getBlockSummary = function(hash, moreTimestamp, next) {
  var self = this;

  function finish(result) {
    if (moreTimestamp > result.time) {
      moreTimestamp = result.time;
    }
    return next(null, result);
  }

  var summaryCache = self.blockSummaryCache.get(hash);

  if (summaryCache) {
    finish(summaryCache);
  } else {
    self.node.services.dashd.getRawBlock(hash, function(err, blockBuffer) {
      if (err) {
        return next(err);
      }

      var br = new dashcore.encoding.BufferReader(blockBuffer);

      // take a shortcut to get number of transactions and the blocksize.
      // Also reads the coinbase transaction and only that.
      // Old code parsed all transactions in every block _and_ then encoded
      // them all back together to get the binary size of the block.
      // FIXME: This code might still read the whole block. Fixing that
      // would require changes in dashcore-node.
      var header = dashcore.BlockHeader.fromBufferReader(br);
      var info = {};
      var txlength = br.readVarintNum();
      info.transactions = [dashcore.Transaction().fromBufferReader(br)];

      self.node.services.dashd.getBlockHeader(hash, function(err, blockHeader) {
        if (err) {
          return next(err);
        }
        var height = blockHeader.height;

        var summary = {
          height: height,
          size: blockBuffer.length,
          hash: hash,
          time: header.time,
          txlength: txlength,
          poolInfo: self.getPoolInfo(info)
        };

        var confirmations = self.node.services.dashd.height - height + 1;
        if (confirmations >= self.blockCacheConfirmations) {
          self.blockSummaryCache.set(hash, summary);
        }

        finish(summary);
      });
    });

  }
};

// List blocks by date
BlockController.prototype.list = function(req, res) {
  var self = this;

  var dateStr;
  var todayStr = this.formatTimestamp(new Date());
  var isToday;

  if (req.query.blockDate) {
    dateStr = req.query.blockDate;
    var datePattern = /\d{4}-\d{2}-\d{2}/;
    if(!datePattern.test(dateStr)) {
      return self.common.handleErrors(new Error('Please use yyyy-mm-dd format'), res);
    }

    isToday = dateStr === todayStr;
  } else {
    dateStr = todayStr;
    isToday = true;
  }

  var gte = Math.round((new Date(dateStr)).getTime() / 1000);

  //pagination
  var lte = parseInt(req.query.startTimestamp) || gte + 86400;
  var prev = this.formatTimestamp(new Date((gte - 86400) * 1000));
  var next = lte ? this.formatTimestamp(new Date(lte * 1000)) : null;
  var limit = parseInt(req.query.limit || BLOCK_LIMIT);
  var more = false;
  var moreTimestamp = lte;

  self.node.services.dashd.getBlockHashesByTimestamp(lte, gte, function(err, hashes) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    hashes.reverse();

    if(hashes.length > limit) {
      more = true;
      hashes = hashes.slice(0, limit);
    }

    async.mapSeries(
      hashes,
      function(hash, next) {
        self._getBlockSummary(hash, moreTimestamp, next);
      },
      function(err, blocks) {
        if(err) {
          return self.common.handleErrors(err, res);
        }

        blocks.sort(function(a, b) {
          return b.height - a.height;
        });

        var data = {
          blocks: blocks,
          length: blocks.length,
          pagination: {
            next: next,
            prev: prev,
            currentTs: lte - 1,
            current: dateStr,
            isToday: isToday,
            more: more
          }
        };

        if(more) {
          data.pagination.moreTs = moreTimestamp;
        }

        res.jsonp(data);
      }
    );
  });
};

BlockController.prototype.getPoolInfo = function(block) {
  var coinbaseBuffer = block.transactions[0].inputs[0]._scriptBuffer;

  for(var k in this.poolStrings) {
    if (coinbaseBuffer.toString('utf-8').match(k)) {
      return this.poolStrings[k];
    }
  }

  return {};
};

//helper to convert timestamps to yyyy-mm-dd format
BlockController.prototype.formatTimestamp = function(date) {
  var yyyy = date.getUTCFullYear().toString();
  var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
  var dd = date.getUTCDate().toString();

  return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
};

/**
 * Previous blockHeader is used to determine block reward
 */
BlockController.prototype.getPreviousBlock = function(prevHash, cb) {
  var self = this;
  //On genesis block, the previousHash will be null.
  if(prevHash===null) cb(null,null);
  else {
      self.node.getBlock(prevHash, function (err, block) {
          if ((err && err.code === -5) || (err && err.code === -8)) {
              return self.common.handleErrors(null, block);
          } else if (err) {
              return self.common.handleErrors(err, block);
          }
          self.node.services.dashd.getBlockHeader(prevHash, function (err, info) {
              if (err) {
                  return self.common.handleErrors(err, info);
              }
              cb(null, info); // return blockHeader
          });
      });
  }
};

const HOURS_IN_A_DAY = 24;
const INITIAL_REWARD_MIN = 50;
const INITIAL_REWARD_MAX = 500;
const DECREMENT_MIN = 1;
const DECREMENT_MAX = 50;

// Function to get a random reward between min and max
function getRandomReward(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Function to calculate rewards for 24 hours
function calculateHourlyRewards() {
  let rewards = new Array(HOURS_IN_A_DAY);

  // Get the initial reward for the first hour
  let initialReward = getRandomReward(INITIAL_REWARD_MIN, INITIAL_REWARD_MAX);
  rewards[0] = initialReward;

  // Calculate rewards for the remaining hours
  for (let i = 1; i < HOURS_IN_A_DAY; ++i) {
    let decrement = getRandomReward(DECREMENT_MIN, DECREMENT_MAX);
    rewards[i] = Math.max(rewards[i - 1] - decrement, 1); // Ensure reward is at least 1
  }

  return rewards;
}

// Global variable to store hourly rewards
let hourlyRewards = calculateHourlyRewards();

BlockController.prototype.getBlockReward = function(prevHash, cb) {
  const nSubsidyHalvingInterval = 210240;
  const nBudgetPaymentsStartBlock = 700;

  this.getPreviousBlock(prevHash, function(err, info) {
    if (err) {
      cb(err, null);
      return;
    }

    let nSubsidyBase;

    if (info === null) {
      // Genesis block reward
      cb(null, parseFloat("50").toFixed(8));
    } else {
      const nPrevHeight = info.height;

      if (nPrevHeight === 0) {
        nSubsidyBase = 50; // Genesis block reward
      } else {
        // Generate random base subsidy between 50 and 500 for each hour
        const hour = Math.floor(nPrevHeight / 60) % 24; // Assuming 1 block per minute, adjust accordingly
        nSubsidyBase = hourlyRewards[hour] - (hour * (450 / 24));
        if (nSubsidyBase < 50) nSubsidyBase = 50; // Ensure the base subsidy doesn't go below 50
      }

      let nSubsidy = nSubsidyBase;

      // Yearly decline of production by ~7.1% per year, projected ~18M coins max by year 2050+.
      for (let i = nSubsidyHalvingInterval; i <= nPrevHeight; i += nSubsidyHalvingInterval) {
        nSubsidy -= nSubsidy / 14;
      }

      let nSuperblockPart = 0;
      // Hard fork to reduce the block reward by 10 extra percent (allowing budget/superblocks)
      if (nPrevHeight > nBudgetPaymentsStartBlock) {
        // Once v20 is active, the treasury is 20% instead of 10%
        nSuperblockPart = nSubsidy / 10; // Adjust this division based on the active version
      }

      const reward = nSubsidy - nSuperblockPart;
      cb(null, parseFloat(reward.toString(10)).toFixed(8));
    }
  });
};

module.exports = BlockController;
