"use strict";

let JannahClient = require('jannah-client'),
  EventEmitter = require('events').EventEmitter,
  logger = require('deelogger')('JobQueue');

/**
 * New Tabs can be requested until master returns 503 signaling
 * that tab could not be allocated, then it has to stop and
 * wait for previosu jobs to finish
 *
 * @XXX maybe it would require more more precise backfeed to job
 * manager to stop feeding new jobs to the queue
 *
 * @param {[type]} masterUrl [description]
 */
class JobQueue extends EventEmitter {
  constructor(masterUrl, waitTimeout) {
    super();

    this._queue = [];
    this._requestingTab = false;
    this._blocked = false;
    this._jannahClient = new JannahClient(masterUrl);

    this._waitTimeout = waitTimeout || 30 * 1000;
    this._nextDelay = null;
  }

  add(id, jobDetails) {
    this._add({
      id           : id,
      jobDetails   : jobDetails,
      failureCount : 0,
      errors       : []
    });
  }

  _add(jobObject) {
    //@XXX maybe it doesn't need to block on when requesting
    //new tab, if there is enough of capacity then tabs could
    //be requested in parallel, available tab count should be
    //monitored somewhere and based on that data it would be
    //possible to decide if tabs can be requested in parallel
    //maybe blocked flag is enough? if one fails they all will
    //start to queue and also could be beneficial to listen for
    //jobResult event to clean _blocked flag, if it queue fills
    //with jobs there might a situation where it goes in cycle
    //request - wait - request - wait ...
    if(this._requestingTab || this._blocked) {
      return this._queue.push(jobObject);
    }

    this._requestTab(jobObject);
  }

  _requestTab(jobObject) {
    let id = jobObject.id,
      jobDetails = jobObject.jobDetails;

    logger.debug('Requsting new tab', {
      jobDetails : jobDetails,
      id         : id
    });

    this._requestingTab = true;

    this._jannahClient.getNewSession({
      engine : jobDetails.engine,
      adblock : false //hard coded until plugins are implemented
    }, (error, tab) => {

      this._requestingTab = false;

      if(error && error.statusCode !== 503 && error.statusCode !== 500) {
        logger.error('Failed to obtain new tab', {
          error      : error.message,
          jobDetails : jobDetails,
          id         : id,
          blocked    : this._blocked
        });

        this._add(jobObject);

        return this._processNext();
      }

      //503 means that tab could not be allocated
      //500 some internal server error, should not keep hammering server
      if(error && (error.statusCode === 503 || error.statusCode === 500)) {

        this._blocked = true;

        this._add(jobObject);

        logger.warn('Tab could not be allocated', {
          id         : id,
          jobDetails : jobDetails,
          blocked    : this._blocked
        });

        return this._processNextWithDelay();
      }

      //@XXX maybe there is a better flow control
      //setting _requestingTab and __blocked flags
      //don't allow for nice waterfall flow control
      this._blocked = false;
      this._doTabSequence(jobObject, tab);
      this._processNext();
    });
  }

  _processNext() {
    if(this._queue.length === 0) {
      return;
    }

    let job = this._queue.shift();

    this._requestTab(job);
  }

  //this one is called when there is 503 from master meaning that tab could
  //not be allocated in that case it must wait for a little while before retrying
  //as there is point retrying right away because other tab open get screenshot
  //etc. sequence is executing and it takes atleast +- 10s for it to complete
  _processNextWithDelay() {
    if(this._nextDelay !== null) {
      return;
    }

    this._nextDelay = setTimeout(() => {
      this._nextDelay = null;
      this._processNext();
    }, this._waitTimeout);
  }

  _doTabSequence(job, tab) {
    let result = {},
      id = job.id,
      jobDetails = job.jobDetails;

    tab.setUserAgent({
      userAgent : jobDetails.userAgent
    })
    .then(() => {
      return tab.setScreenSize({
        size : jobDetails.screenSize
      });
    })
    .then(() => {
      return tab.open({
        url : jobDetails.targetURI,
        waitForResources : true
      });
    })
    .then((status) => {
      logger.info('Page opened with result', {
        status : status
      });

      return tab.getScreenshot();
    })
    .then((screenshot) => {
      result.screenshot = screenshot.data;

      return tab.getResources();
    })
    .then((resources) => {
      result.resources = resources.resources;
      return tab.getConsoleLog();
    })
    .then((data) => {
      result.consoleLog = data.consoleLog;
      return tab.getErrorLog();
    })
    .then((data) => {
      result.errorLog = data.errorLog;
      // return tab.destroy();
      return tab.getPluginResults();
    })
    .then((pluginResults) => {
      result.pluginResults = pluginResults.results;
      return tab.destroy();
    })
    .then(() => {
      this.emit('jobResult', {
        id         : id,
        result     : result,
        jobDetails : jobDetails
      });

      logger.debug('Tab sequence executed', {
        id         : id,
        jobDetails : jobDetails
      });

      this._processNext();
    })
    .catch((error) => {

      job.failureCount += 1;
      job.errors.push({
        message : error.message
      });

      logger.error('Failed to execute tab sequence', {
        error        : error.message,
        jobDetails   : jobDetails,
        id           : id,
        failureCount : job.failureCount
      });


      tab.destroy().catch((error) => {
        logger.error('Failed destroy tab after failure', {
          error : error.message
        });
      });

      if(job.failureCount >= 2) {
        this.emit('failedJob', id, job.errors);
      } else {
        this._add(job);
      }
    });
  }
}

module.exports = JobQueue;
