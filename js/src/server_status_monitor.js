/* vim: set expandtab sw=4 ts=4 sts=4: */
import { PMA_Messages as messages } from './variables/export_variables';
import { $ } from './utils/JqueryExtended';

import 'updated-jqplot';
import './plugins/jquery/jquery.sortableTable';

import 'updated-jqplot/dist/plugins/jqplot.pieRenderer.js';
import 'updated-jqplot/dist/plugins/jqplot.enhancedPieLegendRenderer.js';
import 'updated-jqplot/dist/plugins/jqplot.canvasTextRenderer.js';
import 'updated-jqplot/dist/plugins/jqplot.canvasAxisLabelRenderer.js';
import 'updated-jqplot/dist/plugins/jqplot.dateAxisRenderer.js';
import 'updated-jqplot/dist/plugins/jqplot.highlighter.js';
import 'updated-jqplot/dist/plugins/jqplot.cursor.js';
import './plugins/jqplot/jqplot.byteFormatter';

import { getOsDetail } from './functions/Server/ServerStatusMonitor';
import { isStorageSupported } from './functions/config';
import { createProfilingChart } from './functions/chart';
import CommonParams from './variables/common_params';
import { escapeHtml } from './utils/Sanitise';
import { PMA_getImage } from './functions/get_image';

var runtime = {};
var server_time_diff;
var server_os;
var is_superuser;
var server_db_isLocal;
var chartSize;
export function onload1 () {
    var $js_data_form = $('#js_data');
    server_time_diff  = new Date().getTime() - $js_data_form.find('input[name=server_time]').val();
    server_os =         $js_data_form.find('input[name=server_os]').val();
    is_superuser =      $js_data_form.find('input[name=is_superuser]').val();
    server_db_isLocal = $js_data_form.find('input[name=server_db_isLocal]').val();
}

/**
 * Unbind all event handlers before tearing down a page
 */
export function teardown1 () {
    $('#emptyDialog').remove();
    $('#addChartDialog').remove();
    $('a.popupLink').off('click');
    $('body').off('click');
}
/**
 * Popup behaviour
 */
export function onload2 () {
    $('<div />')
        .attr('id', 'emptyDialog')
        .appendTo('#page_content');
    $('#addChartDialog')
        .appendTo('#page_content');

    $('a.popupLink').on('click', function () {
        var $link = $(this);
        $('div.' + $link.attr('href').substr(1))
            .show()
            .offset({ top: $link.offset().top + $link.height() + 5, left: $link.offset().left })
            .addClass('openedPopup');

        return false;
    });
    $('body').on('click', function (event) {
        $('div.openedPopup').each(function () {
            var $cnt = $(this);
            var pos = $cnt.offset();
            // Hide if the mouseclick is outside the popupcontent
            if (event.pageX < pos.left ||
                event.pageY < pos.top ||
                event.pageX > pos.left + $cnt.outerWidth() ||
                event.pageY > pos.top + $cnt.outerHeight()
            ) {
                $cnt.hide().removeClass('openedPopup');
            }
        });
    });
}

export function teardown2 () {
    $('a[href="#rearrangeCharts"], a[href="#endChartEditMode"]').off('click');
    $('div.popupContent select[name="chartColumns"]').off('change');
    $('div.popupContent select[name="gridChartRefresh"]').off('change');
    $('a[href="#addNewChart"]').off('click');
    $('a[href="#exportMonitorConfig"]').off('click');
    $('a[href="#importMonitorConfig"]').off('click');
    $('a[href="#clearMonitorConfig"]').off('click');
    $('a[href="#pauseCharts"]').off('click');
    $('a[href="#monitorInstructionsDialog"]').off('click');
    $('input[name="chartType"]').off('click');
    $('input[name="useDivisor"]').off('click');
    $('input[name="useUnit"]').off('click');
    $('select[name="varChartList"]').off('click');
    $('a[href="#kibDivisor"]').off('click');
    $('a[href="#mibDivisor"]').off('click');
    $('a[href="#submitClearSeries"]').off('click');
    $('a[href="#submitAddSeries"]').off('click');
    // $("input#variableInput").destroy();
    $('#chartPreset').off('click');
    $('#chartStatusVar').off('click');
    destroyGrid();
}

export function onload3 () {
    // Show tab links
    $('div.tabLinks').show();
    $('#loadingMonitorIcon').remove();
    // Codemirror is loaded on demand so we might need to initialize it
    if (! codemirror_editor) {
        var $elm = $('#sqlquery');
        if ($elm.length > 0 && typeof CodeMirror !== 'undefined') {
            codemirror_editor = CodeMirror.fromTextArea(
                $elm[0],
                {
                    lineNumbers: true,
                    matchBrackets: true,
                    indentUnit: 4,
                    mode: 'text/x-mysql',
                    lineWrapping: true
                }
            );
        }
    }
    // Timepicker is loaded on demand so we need to initialize
    // datetime fields from the 'load log' dialog
    $('#logAnalyseDialog').find('.datetimefield').each(function () {
        PMA_addDatepicker($(this));
    });

    /** ** Monitor charting implementation ****/
    /* Saves the previous ajax response for differential values */
    var oldChartData = null;
    // Holds about to be created chart
    var newChart = null;
    var chartSpacing;

    // Whenever the monitor object (runtime.charts) or the settings object
    // (monitorSettings) changes in a way incompatible to the previous version,
    // increase this number. It will reset the users monitor and settings object
    // in his localStorage to the default configuration
    var monitorProtocolVersion = '1.0';

    // Runtime parameter of the monitor, is being fully set in initGrid()
    runtime = {
        // Holds all visible charts in the grid
        charts: null,
        // Stores the timeout handler so it can be cleared
        refreshTimeout: null,
        // Stores the GET request to refresh the charts
        refreshRequest: null,
        // Chart auto increment
        chartAI: 0,
        // To play/pause the monitor
        redrawCharts: false,
        // Object that contains a list of nodes that need to be retrieved
        // from the server for chart updates
        dataList: [],
        // Current max points per chart (needed for auto calculation)
        gridMaxPoints: 20,
        // displayed time frame
        xmin: -1,
        xmax: -1
    };
    var monitorSettings = null;

    var defaultMonitorSettings = {
        columns: 3,
        chartSize: { width: 295, height: 250 },
        // Max points in each chart. Settings it to 'auto' sets
        // gridMaxPoints to (chartwidth - 40) / 12
        gridMaxPoints: 'auto',
        /* Refresh rate of all grid charts in ms */
        gridRefresh: 5000
    };

    // Allows drag and drop rearrange and print/edit icons on charts
    var editMode = false;

    /* List of preconfigured charts that the user may select */
    var presetCharts = {
        // Query cache efficiency
        'qce': {
            title: messages.strQueryCacheEfficiency,
            series: [{
                label: messages.strQueryCacheEfficiency
            }],
            nodes: [{
                dataPoints: [{ type: 'statusvar', name: 'Qcache_hits' }, { type: 'statusvar', name: 'Com_select' }],
                transformFn: 'qce'
            }],
            maxYLabel: 0
        },
        // Query cache usage
        'qcu': {
            title: messages.strQueryCacheUsage,
            series: [{
                label: messages.strQueryCacheUsed
            }],
            nodes: [{
                dataPoints: [{ type: 'statusvar', name: 'Qcache_free_memory' }, { type: 'servervar', name: 'query_cache_size' }],
                transformFn: 'qcu'
            }],
            maxYLabel: 0
        }
    };

    // time span selection
    var selectionTimeDiff = [];
    var selectionStartX;
    var selectionStartY;
    // var selectionEndX;
    // var selectionEndY;
    var drawTimeSpan = false;

    // chart tooltip
    // var tooltipBox;

    getOsDetail(server_os, presetCharts);

    // Default setting for the chart grid
    var defaultChartGrid = {
        'c0': {
            title: messages.strQuestions,
            series: [
                { label: messages.strQuestions }
            ],
            nodes: [
                { dataPoints: [{ type: 'statusvar', name: 'Questions' }], display: 'differential' }
            ],
            maxYLabel: 0
        },
        'c1': {
            title: messages.strChartConnectionsTitle,
            series: [
                { label: messages.strConnections },
                { label: messages.strProcesses }
            ],
            nodes: [
                { dataPoints: [{ type: 'statusvar', name: 'Connections' }], display: 'differential' },
                { dataPoints: [{ type: 'proc', name: 'processes' }] }
            ],
            maxYLabel: 0
        },
        'c2': {
            title: messages.strTraffic,
            series: [
                { label: messages.strBytesSent },
                { label: messages.strBytesReceived }
            ],
            nodes: [
                { dataPoints: [{ type: 'statusvar', name: 'Bytes_sent' }], display: 'differential', valueDivisor: 1024 },
                { dataPoints: [{ type: 'statusvar', name: 'Bytes_received' }], display: 'differential', valueDivisor: 1024 }
            ],
            maxYLabel: 0
        }
    };

    // Server is localhost => We can add cpu/memory/swap to the default chart
    if (server_db_isLocal && typeof presetCharts.cpu !== 'undefined') {
        defaultChartGrid.c3 = presetCharts.cpu;
        defaultChartGrid.c4 = presetCharts.memory;
        defaultChartGrid.c5 = presetCharts.swap;
    }

    $('a[href="#rearrangeCharts"], a[href="#endChartEditMode"]').on('click', function (event) {
        event.preventDefault();
        editMode = !editMode;
        if ($(this).attr('href') === '#endChartEditMode') {
            editMode = false;
        }

        $('a[href="#endChartEditMode"]').toggle(editMode);

        if (editMode) {
            // Close the settings popup
            $('div.popupContent').hide().removeClass('openedPopup');

            $('#chartGrid').sortableTable({
                ignoreRect: {
                    top: 8,
                    left: chartSize.width - 63,
                    width: 54,
                    height: 24
                }
            });
        } else {
            $('#chartGrid').sortableTable('destroy');
        }
        saveMonitor(); // Save settings
        return false;
    });

    // global settings
    $('div.popupContent select[name="chartColumns"]').on('change', function () {
        monitorSettings.columns = parseInt(this.value, 10);

        calculateChartSize();
        // Empty cells should keep their size so you can drop onto them
        $('#chartGrid').find('tr td').css('width', chartSize.width + 'px');
        $('#chartGrid').find('.monitorChart').css({
            width: chartSize.width + 'px',
            height: chartSize.height + 'px'
        });

        /* Reorder all charts that it fills all column cells */
        var numColumns;
        var $tr = $('#chartGrid').find('tr:first');
        var row = 0;

        var tempManageCols = function () {
            if (numColumns > monitorSettings.columns) {
                if ($tr.next().length === 0) {
                    $tr.after('<tr></tr>');
                }
                $tr.next().prepend($(this));
            }
            numColumns++;
        };

        var tempAddCol = function () {
            if ($(this).next().length !== 0) {
                $(this).append($(this).next().find('td:first'));
            }
        };

        while ($tr.length !== 0) {
            numColumns = 1;
            // To many cells in one row => put into next row
            $tr.find('td').each(tempManageCols);

            // To little cells in one row => for each cell to little,
            // move all cells backwards by 1
            if ($tr.next().length > 0) {
                var cnt = monitorSettings.columns - $tr.find('td').length;
                for (var i = 0; i < cnt; i++) {
                    $tr.append($tr.next().find('td:first'));
                    $tr.nextAll().each(tempAddCol);
                }
            }

            $tr = $tr.next();
            row++;
        }

        if (monitorSettings.gridMaxPoints === 'auto') {
            runtime.gridMaxPoints = Math.round((chartSize.width - 40) / 12);
        }

        runtime.xmin = new Date().getTime() - server_time_diff - runtime.gridMaxPoints * monitorSettings.gridRefresh;
        runtime.xmax = new Date().getTime() - server_time_diff + monitorSettings.gridRefresh;

        if (editMode) {
            $('#chartGrid').sortableTable('refresh');
        }

        refreshChartGrid();
        saveMonitor(); // Save settings
    });

    $('div.popupContent select[name="gridChartRefresh"]').on('change', function () {
        monitorSettings.gridRefresh = parseInt(this.value, 10) * 1000;
        clearTimeout(runtime.refreshTimeout);

        if (runtime.refreshRequest) {
            runtime.refreshRequest.abort();
        }

        runtime.xmin = new Date().getTime() - server_time_diff - runtime.gridMaxPoints * monitorSettings.gridRefresh;
        // fixing chart shift towards left on refresh rate change
        // runtime.xmax = new Date().getTime() - server_time_diff + monitorSettings.gridRefresh;
        runtime.refreshTimeout = setTimeout(refreshChartGrid, monitorSettings.gridRefresh);

        saveMonitor(); // Save settings
    });

    $('a[href="#addNewChart"]').on('click', function (event) {
        event.preventDefault();
        var dlgButtons = { };

        dlgButtons[messages.strAddChart] = function () {
            var type = $('input[name="chartType"]:checked').val();

            if (type === 'preset') {
                newChart = presetCharts[$('#addChartDialog').find('select[name="presetCharts"]').prop('value')];
            } else {
                // If user builds his own chart, it's being set/updated
                // each time he adds a series
                // So here we only warn if he didn't add a series yet
                if (! newChart || ! newChart.nodes || newChart.nodes.length === 0) {
                    alert(messages.strAddOneSeriesWarning);
                    return;
                }
            }

            newChart.title = $('input[name="chartTitle"]').val();
            // Add a cloned object to the chart grid
            addChart($.extend(true, {}, newChart));

            newChart = null;

            saveMonitor(); // Save settings

            $(this).dialog('close');
        };

        dlgButtons[messages.strClose] = function () {
            newChart = null;
            $('span#clearSeriesLink').hide();
            $('#seriesPreview').html('');
            $(this).dialog('close');
        };

        var $presetList = $('#addChartDialog').find('select[name="presetCharts"]');
        if ($presetList.html().length === 0) {
            $.each(presetCharts, function (key, value) {
                $presetList.append('<option value="' + key + '">' + value.title + '</option>');
            });
            $presetList.on('change', function () {
                $('input[name="chartTitle"]').val(
                    $presetList.find(':selected').text()
                );
                $('#chartPreset').prop('checked', true);
            });
            $('#chartPreset').on('click', function () {
                $('input[name="chartTitle"]').val(
                    $presetList.find(':selected').text()
                );
            });
            $('#chartStatusVar').on('click', function () {
                $('input[name="chartTitle"]').val(
                    $('#chartSeries').find(':selected').text().replace(/_/g, ' ')
                );
            });
            $('#chartSeries').on('change', function () {
                $('input[name="chartTitle"]').val(
                    $('#chartSeries').find(':selected').text().replace(/_/g, ' ')
                );
            });
        }

        $('#addChartDialog').dialog({
            width: 'auto',
            height: 'auto',
            buttons: dlgButtons
        });

        $('#seriesPreview').html('<i>' + messages.strNone + '</i>');

        return false;
    });

    $('a[href="#exportMonitorConfig"]').on('click', function (event) {
        event.preventDefault();
        var gridCopy = {};
        $.each(runtime.charts, function (key, elem) {
            gridCopy[key] = {};
            gridCopy[key].nodes = elem.nodes;
            gridCopy[key].settings = elem.settings;
            gridCopy[key].title = elem.title;
        });
        var exportData = {
            monitorCharts: gridCopy,
            monitorSettings: monitorSettings
        };

        var blob = new Blob([JSON.stringify(exportData)], { type: 'application/octet-stream' });
        var url = window.URL.createObjectURL(blob);
        window.location.href = url;
        window.URL.revokeObjectURL(url);
    });

    $('a[href="#importMonitorConfig"]').on('click', function (event) {
        event.preventDefault();
        $('#emptyDialog').dialog({ title: messages.strImportDialogTitle });
        $('#emptyDialog').html(messages.strImportDialogMessage + ':<br/><form>' +
            '<input type="file" name="file" id="import_file"> </form>');

        var dlgBtns = {};

        dlgBtns[messages.strImport] = function () {
            var input = $('#emptyDialog').find('#import_file')[0];
            var reader = new FileReader();

            reader.onerror = function (event) {
                alert(messages.strFailedParsingConfig + '\n' + event.target.error.code);
            };
            reader.onload = function (e) {
                var data = e.target.result;

                // Try loading config
                try {
                    json = JSON.parse(data);
                } catch (err) {
                    alert(messages.strFailedParsingConfig);
                    $('#emptyDialog').dialog('close');
                    return;
                }

                // Basic check, is this a monitor config json?
                if (!json || ! json.monitorCharts || ! json.monitorCharts) {
                    alert(messages.strFailedParsingConfig);
                    $('#emptyDialog').dialog('close');
                    return;
                }

                // If json ok, try applying config
                try {
                    window.localStorage.monitorCharts = JSON.stringify(json.monitorCharts);
                    window.localStorage.monitorSettings = JSON.stringify(json.monitorSettings);
                    rebuildGrid();
                } catch (err) {
                    alert(messages.strFailedBuildingGrid);
                    // If an exception is thrown, load default again
                    if (isStorageSupported('localStorage')) {
                        window.localStorage.removeItem('monitorCharts');
                        window.localStorage.removeItem('monitorSettings');
                    }
                    rebuildGrid();
                }

                $('#emptyDialog').dialog('close');
            };
            reader.readAsText(input.files[0]);
        };

        dlgBtns[messages.strCancel] = function () {
            $(this).dialog('close');
        };

        $('#emptyDialog').dialog({
            width: 'auto',
            height: 'auto',
            buttons: dlgBtns
        });
    });

    $('a[href="#clearMonitorConfig"]').on('click', function (event) {
        event.preventDefault();
        if (isStorageSupported('localStorage')) {
            window.localStorage.removeItem('monitorCharts');
            window.localStorage.removeItem('monitorSettings');
            window.localStorage.removeItem('monitorVersion');
        }
        $(this).hide();
        rebuildGrid();
    });

    $('a[href="#pauseCharts"]').on('click', function (event) {
        event.preventDefault();
        runtime.redrawCharts = ! runtime.redrawCharts;
        if (! runtime.redrawCharts) {
            $(this).html(PMA_getImage('play') + messages.strResumeMonitor);
        } else {
            $(this).html(PMA_getImage('pause') + messages.strPauseMonitor);
            if (! runtime.charts) {
                initGrid();
                $('a[href="#settingsPopup"]').show();
            }
        }
        return false;
    });

    $('a[href="#monitorInstructionsDialog"]').on('click', function (event) {
        event.preventDefault();

        var $dialog = $('#monitorInstructionsDialog');

        $dialog.dialog({
            width: 595,
            height: 'auto'
        }).find('img.ajaxIcon').show();

        var loadLogVars = function (getvars) {
            var vars = { ajax_request: true, logging_vars: true };
            if (getvars) {
                $.extend(vars, getvars);
            }

            $.get('server_status_monitor.php' + CommonParams.get('common_query'), vars,
                function (data) {
                    var logVars;
                    if (typeof data !== 'undefined' && data.success === true) {
                        logVars = data.message;
                    } else {
                        return serverResponseError();
                    }
                    var icon = PMA_getImage('s_success');
                    var msg = '';
                    var str = '';

                    if (logVars.general_log === 'ON') {
                        if (logVars.slow_query_log === 'ON') {
                            msg = messages.strBothLogOn;
                        } else {
                            msg = messages.strGenLogOn;
                        }
                    }

                    if (msg.length === 0 && logVars.slow_query_log === 'ON') {
                        msg = messages.strSlowLogOn;
                    }

                    if (msg.length === 0) {
                        icon = PMA_getImage('s_error');
                        msg = messages.strBothLogOff;
                    }

                    str = '<b>' + messages.strCurrentSettings + '</b><br/><div class="smallIndent">';
                    str += icon + msg + '<br />';

                    if (logVars.log_output !== 'TABLE') {
                        str += PMA_getImage('s_error') + ' ' + messages.strLogOutNotTable + '<br />';
                    } else {
                        str += PMA_getImage('s_success') + ' ' + messages.strLogOutIsTable + '<br />';
                    }

                    if (logVars.slow_query_log === 'ON') {
                        if (logVars.long_query_time > 2) {
                            str += PMA_getImage('s_attention') + ' ';
                            str += PMA_sprintf(messages.strSmallerLongQueryTimeAdvice, logVars.long_query_time);
                            str += '<br />';
                        }

                        if (logVars.long_query_time < 2) {
                            str += PMA_getImage('s_success') + ' ';
                            str += PMA_sprintf(messages.strLongQueryTimeSet, logVars.long_query_time);
                            str += '<br />';
                        }
                    }

                    str += '</div>';

                    if (is_superuser) {
                        str += '<p></p><b>' + messages.strChangeSettings + '</b>';
                        str += '<div class="smallIndent">';
                        str += messages.strSettingsAppliedGlobal + '<br/>';

                        var varValue = 'TABLE';
                        if (logVars.log_output === 'TABLE') {
                            varValue = 'FILE';
                        }

                        str += '- <a class="set" href="#log_output-' + varValue + '">';
                        str += PMA_sprintf(messages.strSetLogOutput, varValue);
                        str += ' </a><br />';

                        if (logVars.general_log !== 'ON') {
                            str += '- <a class="set" href="#general_log-ON">';
                            str += PMA_sprintf(messages.strEnableVar, 'general_log');
                            str += ' </a><br />';
                        } else {
                            str += '- <a class="set" href="#general_log-OFF">';
                            str += PMA_sprintf(messages.strDisableVar, 'general_log');
                            str += ' </a><br />';
                        }

                        if (logVars.slow_query_log !== 'ON') {
                            str += '- <a class="set" href="#slow_query_log-ON">';
                            str +=  PMA_sprintf(messages.strEnableVar, 'slow_query_log');
                            str += ' </a><br />';
                        } else {
                            str += '- <a class="set" href="#slow_query_log-OFF">';
                            str +=  PMA_sprintf(messages.strDisableVar, 'slow_query_log');
                            str += ' </a><br />';
                        }

                        varValue = 5;
                        if (logVars.long_query_time > 2) {
                            varValue = 1;
                        }

                        str += '- <a class="set" href="#long_query_time-' + varValue + '">';
                        str += PMA_sprintf(messages.setSetLongQueryTime, varValue);
                        str += ' </a><br />';
                    } else {
                        str += messages.strNoSuperUser + '<br/>';
                    }

                    str += '</div>';

                    $dialog.find('div.monitorUse').toggle(
                        logVars.log_output === 'TABLE' && (logVars.slow_query_log === 'ON' || logVars.general_log === 'ON')
                    );

                    $dialog.find('div.ajaxContent').html(str);
                    $dialog.find('img.ajaxIcon').hide();
                    $dialog.find('a.set').on('click', function () {
                        var nameValue = $(this).attr('href').split('-');
                        loadLogVars({ varName: nameValue[0].substr(1), varValue: nameValue[1] });
                        $dialog.find('img.ajaxIcon').show();
                    });
                }
            );
        };


        loadLogVars();

        return false;
    });

    $('input[name="chartType"]').on('change', function () {
        $('#chartVariableSettings').toggle(this.checked && this.value === 'variable');
        var title = $('input[name="chartTitle"]').val();
        if (title === messages.strChartTitle ||
            title === $('label[for="' + $('input[name="chartTitle"]').data('lastRadio') + '"]').text()
        ) {
            $('input[name="chartTitle"]')
                .data('lastRadio', $(this).attr('id'))
                .val($('label[for="' + $(this).attr('id') + '"]').text());
        }
    });

    $('input[name="useDivisor"]').on('change', function () {
        $('span.divisorInput').toggle(this.checked);
    });

    $('input[name="useUnit"]').on('change', function () {
        $('span.unitInput').toggle(this.checked);
    });

    $('select[name="varChartList"]').on('change', function () {
        if (this.selectedIndex !== 0) {
            $('#variableInput').val(this.value);
        }
    });

    $('a[href="#kibDivisor"]').on('click', function (event) {
        event.preventDefault();
        $('input[name="valueDivisor"]').val(1024);
        $('input[name="valueUnit"]').val(messages.strKiB);
        $('span.unitInput').toggle(true);
        $('input[name="useUnit"]').prop('checked', true);
        return false;
    });

    $('a[href="#mibDivisor"]').on('click', function (event) {
        event.preventDefault();
        $('input[name="valueDivisor"]').val(1024 * 1024);
        $('input[name="valueUnit"]').val(messages.strMiB);
        $('span.unitInput').toggle(true);
        $('input[name="useUnit"]').prop('checked', true);
        return false;
    });

    $('a[href="#submitClearSeries"]').on('click', function (event) {
        event.preventDefault();
        $('#seriesPreview').html('<i>' + messages.strNone + '</i>');
        newChart = null;
        $('#clearSeriesLink').hide();
    });

    $('a[href="#submitAddSeries"]').on('click', function (event) {
        event.preventDefault();
        if ($('#variableInput').val() === '') {
            return false;
        }

        if (newChart === null) {
            $('#seriesPreview').html('');

            newChart = {
                title: $('input[name="chartTitle"]').val(),
                nodes: [],
                series: [],
                maxYLabel: 0
            };
        }

        var serie = {
            dataPoints: [{ type: 'statusvar', name: $('#variableInput').val() }],
            display: $('input[name="differentialValue"]').prop('checked') ? 'differential' : ''
        };

        if (serie.dataPoints[0].name === 'Processes') {
            serie.dataPoints[0].type = 'proc';
        }

        if ($('input[name="useDivisor"]').prop('checked')) {
            serie.valueDivisor = parseInt($('input[name="valueDivisor"]').val(), 10);
        }

        if ($('input[name="useUnit"]').prop('checked')) {
            serie.unit = $('input[name="valueUnit"]').val();
        }

        var str = serie.display === 'differential' ? ', ' + messages.strDifferential : '';
        str += serie.valueDivisor ? (', ' + PMA_sprintf(messages.strDividedBy, serie.valueDivisor)) : '';
        str += serie.unit ? (', ' + messages.strUnit + ': ' + serie.unit) : '';

        var newSeries = {
            label: $('#variableInput').val().replace(/_/g, ' ')
        };
        newChart.series.push(newSeries);
        $('#seriesPreview').append('- ' + escapeHtml(newSeries.label + str) + '<br/>');
        newChart.nodes.push(serie);
        $('#variableInput').val('');
        $('input[name="differentialValue"]').prop('checked', true);
        $('input[name="useDivisor"]').prop('checked', false);
        $('input[name="useUnit"]').prop('checked', false);
        $('input[name="useDivisor"]').trigger('change');
        $('input[name="useUnit"]').trigger('change');
        $('select[name="varChartList"]').get(0).selectedIndex = 0;

        $('#clearSeriesLink').show();

        return false;
    });

    // $('#variableInput').autocomplete({
    //     source: variableNames
    // });

    /* Initializes the monitor, called only once */
    function initGrid () {
        var i;

        /* Apply default values & config */
        if (isStorageSupported('localStorage')) {
            if (typeof window.localStorage.monitorCharts !== 'undefined') {
                runtime.charts = JSON.parse(window.localStorage.monitorCharts);
            }
            if (typeof window.localStorage.monitorSettings !== 'undefined') {
                monitorSettings = JSON.parse(window.localStorage.monitorSettings);
            }

            $('a[href="#clearMonitorConfig"]').toggle(runtime.charts !== null);

            if (runtime.charts !== null
                && typeof window.localStorage.monitorVersion !== 'undefined'
                && monitorProtocolVersion !== window.localStorage.monitorVersion
            ) {
                $('#emptyDialog').dialog({ title: messages.strIncompatibleMonitorConfig });
                $('#emptyDialog').html(messages.strIncompatibleMonitorConfigDescription);

                var dlgBtns = {};
                dlgBtns[messages.strClose] = function () {
                    $(this).dialog('close');
                };

                $('#emptyDialog').dialog({
                    width: 400,
                    buttons: dlgBtns
                });
            }
        }

        if (runtime.charts === null) {
            runtime.charts = defaultChartGrid;
        }
        if (monitorSettings === null) {
            monitorSettings = defaultMonitorSettings;
        }

        $('select[name="gridChartRefresh"]').val(monitorSettings.gridRefresh / 1000);
        $('select[name="chartColumns"]').val(monitorSettings.columns);

        if (monitorSettings.gridMaxPoints === 'auto') {
            runtime.gridMaxPoints = Math.round((monitorSettings.chartSize.width - 40) / 12);
        } else {
            runtime.gridMaxPoints = monitorSettings.gridMaxPoints;
        }

        runtime.xmin = new Date().getTime() - server_time_diff - runtime.gridMaxPoints * monitorSettings.gridRefresh;
        runtime.xmax = new Date().getTime() - server_time_diff + monitorSettings.gridRefresh;

        /* Calculate how much spacing there is between each chart */
        $('#chartGrid').html('<tr><td></td><td></td></tr><tr><td></td><td></td></tr>');
        chartSpacing = {
            width: $('#chartGrid').find('td:nth-child(2)').offset().left -
                $('#chartGrid').find('td:nth-child(1)').offset().left,
            height: $('#chartGrid').find('tr:nth-child(2) td:nth-child(2)').offset().top -
                $('#chartGrid').find('tr:nth-child(1) td:nth-child(1)').offset().top
        };
        $('#chartGrid').html('');

        /* Add all charts - in correct order */
        var keys = [];
        $.each(runtime.charts, function (key, value) {
            keys.push(key);
        });
        keys.sort();
        for (i = 0; i < keys.length; i++) {
            addChart(runtime.charts[keys[i]], true);
        }

        /* Fill in missing cells */
        var numCharts = $('#chartGrid').find('.monitorChart').length;
        var numMissingCells = (monitorSettings.columns - numCharts % monitorSettings.columns) % monitorSettings.columns;
        for (i = 0; i < numMissingCells; i++) {
            $('#chartGrid').find('tr:last').append('<td></td>');
        }

        // Empty cells should keep their size so you can drop onto them
        calculateChartSize();
        $('#chartGrid').find('tr td').css('width', chartSize.width + 'px');

        buildRequiredDataList();
        refreshChartGrid();
    }

    /* Calls destroyGrid() and initGrid(), but before doing so it saves the chart
     * data from each chart and restores it after the monitor is initialized again */
    function rebuildGrid () {
        var oldData = null;
        if (runtime.charts) {
            oldData = {};
            $.each(runtime.charts, function (key, chartObj) {
                for (var i = 0, l = chartObj.nodes.length; i < l; i++) {
                    oldData[chartObj.nodes[i].dataPoint] = [];
                    for (var j = 0, ll = chartObj.chart.series[i].data.length; j < ll; j++) {
                        oldData[chartObj.nodes[i].dataPoint].push([chartObj.chart.series[i].data[j].x, chartObj.chart.series[i].data[j].y]);
                    }
                }
            });
        }

        destroyGrid();
        initGrid();
    }

    /* Calculactes the dynamic chart size that depends on the column width */
    function calculateChartSize () {
        var panelWidth;
        if ($('body').height() > $(window).height()) { // has vertical scroll bar
            panelWidth = $('#logTable').innerWidth();
        } else {
            panelWidth = $('#logTable').innerWidth() - 10; // leave some space for vertical scroll bar
        }

        var wdt = panelWidth;
        var windowWidth = $(window).width();

        if (windowWidth > 768) {
            wdt = (panelWidth - monitorSettings.columns * chartSpacing.width) / monitorSettings.columns;
        }

        chartSize = {
            width: Math.floor(wdt),
            height: Math.floor(0.75 * wdt)
        };
    }

    /* Adds a chart to the chart grid */
    function addChart (chartObj, initialize) {
        var i;
        var settings = {
            title: escapeHtml(chartObj.title),
            grid: {
                drawBorder: false,
                shadow: false,
                background: 'rgba(0,0,0,0)'
            },
            axes: {
                xaxis: {
                    renderer: $.jqplot.DateAxisRenderer,
                    tickOptions: {
                        formatString: '%H:%M:%S',
                        showGridline: false
                    },
                    min: runtime.xmin,
                    max: runtime.xmax
                },
                yaxis: {
                    min: 0,
                    max: 100,
                    tickInterval: 20
                }
            },
            seriesDefaults: {
                rendererOptions: {
                    smooth: true
                },
                showLine: true,
                lineWidth: 2,
                markerOptions: {
                    size: 6
                }
            },
            highlighter: {
                show: true
            }
        };

        if (settings.title === messages.strSystemCPUUsage ||
            settings.title === messages.strQueryCacheEfficiency
        ) {
            settings.axes.yaxis.tickOptions = {
                formatString: '%d %%'
            };
        } else if (settings.title === messages.strSystemMemory ||
            settings.title === messages.strSystemSwap
        ) {
            settings.stackSeries = true;
            settings.axes.yaxis.tickOptions = {
                formatter: $.jqplot.byteFormatter(2) // MiB
            };
        } else if (settings.title === messages.strTraffic) {
            settings.axes.yaxis.tickOptions = {
                formatter: $.jqplot.byteFormatter(1) // KiB
            };
        } else if (settings.title === messages.strQuestions ||
            settings.title === messages.strConnections
        ) {
            settings.axes.yaxis.tickOptions = {
                formatter: function (format, val) {
                    if (Math.abs(val) >= 1000000) {
                        return $.jqplot.sprintf('%.3g M', val / 1000000);
                    } else if (Math.abs(val) >= 1000) {
                        return $.jqplot.sprintf('%.3g k', val / 1000);
                    } else {
                        return $.jqplot.sprintf('%d', val);
                    }
                }
            };
        }

        settings.series = chartObj.series;

        if ($('#' + 'gridchart' + runtime.chartAI).length === 0) {
            var numCharts = $('#chartGrid').find('.monitorChart').length;

            if (numCharts === 0 || (numCharts % monitorSettings.columns === 0)) {
                $('#chartGrid').append('<tr></tr>');
            }

            if (!chartSize) {
                calculateChartSize();
            }
            $('#chartGrid').find('tr:last').append(
                '<td><div id="gridChartContainer' + runtime.chartAI + '" class="">' +
                '<div class="ui-state-default monitorChart"' +
                ' id="gridchart' + runtime.chartAI + '"' +
                ' style="width:' + chartSize.width + 'px; height:' + chartSize.height + 'px;"></div>' +
                '</div></td>'
            );
        }

        // Set series' data as [0,0], smooth lines won't plot with data array having null values.
        // also chart won't plot initially with no data and data comes on refreshChartGrid()
        var series = [];
        for (i in chartObj.series) {
            series.push([[0, 0]]);
        }

        var tempTooltipContentEditor = function (str, seriesIndex, pointIndex, plot) {
            var j;
            // TODO: move style to theme CSS
            var tooltipHtml = '<div style="font-size:12px;background-color:#FFFFFF;' +
                'opacity:0.95;filter:alpha(opacity=95);padding:5px;">';
            // x value i.e. time
            var timeValue = str.split(',')[0];
            var seriesValue;
            tooltipHtml += 'Time: ' + timeValue;
            tooltipHtml += '<span style="font-weight:bold;">';
            // Add y values to the tooltip per series
            for (j in plot.series) {
                // get y value if present
                if (plot.series[j].data.length > pointIndex) {
                    seriesValue = plot.series[j].data[pointIndex][1];
                } else {
                    return;
                }
                var seriesLabel = plot.series[j].label;
                var seriesColor = plot.series[j].color;
                // format y value
                if (plot.series[0]._yaxis.tickOptions.formatter) {
                    // using formatter function
                    seriesValue = plot.series[0]._yaxis.tickOptions.formatter('%s', seriesValue);
                } else if (plot.series[0]._yaxis.tickOptions.formatString) {
                    // using format string
                    seriesValue = PMA_sprintf(plot.series[0]._yaxis.tickOptions.formatString, seriesValue);
                }
                tooltipHtml += '<br /><span style="color:' + seriesColor + '">' +
                    seriesLabel + ': ' + seriesValue + '</span>';
            }
            tooltipHtml += '</span></div>';
            return tooltipHtml;
        };

        // set Tooltip for each series
        for (i in settings.series) {
            settings.series[i].highlighter = {
                show: true,
                tooltipContentEditor: tempTooltipContentEditor
            };
        }

        chartObj.chart = $.jqplot('gridchart' + runtime.chartAI, series, settings);
        // remove [0,0] after plotting
        for (i in chartObj.chart.series) {
            chartObj.chart.series[i].data.shift();
        }

        var $legend = $('<div />').css('padding', '0.5em');
        for (i in chartObj.chart.series) {
            $legend.append(
                $('<div />').append(
                    $('<div>').css({
                        width: '1em',
                        height: '1em',
                        background: chartObj.chart.seriesColors[i]
                    }).addClass('floatleft')
                ).append(
                    $('<div>').text(
                        chartObj.chart.series[i].label
                    ).addClass('floatleft')
                ).append(
                    $('<div class="clearfloat">')
                ).addClass('floatleft')
            );
        }
        $('#gridchart' + runtime.chartAI)
            .parent()
            .append($legend);

        if (initialize !== true) {
            runtime.charts['c' + runtime.chartAI] = chartObj;
            buildRequiredDataList();
        }

        // time span selection
        $('#gridchart' + runtime.chartAI).on('jqplotMouseDown', function (ev, gridpos, datapos, neighbor, plot) {
            drawTimeSpan = true;
            selectionTimeDiff.push(datapos.xaxis);
            if ($('#selection_box').length) {
                $('#selection_box').remove();
            }
            var selectionBox = $('<div id="selection_box" style="z-index:1000;height:205px;position:absolute;background-color:#87CEEB;opacity:0.4;filter:alpha(opacity=40);pointer-events:none;">');
            $(document.body).append(selectionBox);
            selectionStartX = ev.pageX;
            selectionStartY = ev.pageY;
            selectionBox
                .attr({ id: 'selection_box' })
                .css({
                    top: selectionStartY - gridpos.y,
                    left: selectionStartX
                })
                .fadeIn();
        });

        $('#gridchart' + runtime.chartAI).on('jqplotMouseUp', function (ev, gridpos, datapos, neighbor, plot) {
            if (! drawTimeSpan || editMode) {
                return;
            }

            selectionTimeDiff.push(datapos.xaxis);

            if (selectionTimeDiff[1] <= selectionTimeDiff[0]) {
                selectionTimeDiff = [];
                return;
            }
            // get date from timestamp
            var min = new Date(Math.ceil(selectionTimeDiff[0]));
            var max = new Date(Math.ceil(selectionTimeDiff[1]));
            PMA_getLogAnalyseDialog(min, max);
            selectionTimeDiff = [];
            drawTimeSpan = false;
        });

        $('#gridchart' + runtime.chartAI).on('jqplotMouseMove', function (ev, gridpos, datapos, neighbor, plot) {
            if (! drawTimeSpan || editMode) {
                return;
            }
            if (selectionStartX !== undefined) {
                $('#selection_box')
                    .css({
                        width: Math.ceil(ev.pageX - selectionStartX)
                    })
                    .fadeIn();
            }
        });

        $('#gridchart' + runtime.chartAI).on('jqplotMouseLeave', function (ev, gridpos, datapos, neighbor, plot) {
            drawTimeSpan = false;
        });

        $(document.body).mouseup(function () {
            if ($('#selection_box').length) {
                $('#selection_box').remove();
            }
        });

        // Edit, Print icon only in edit mode
        $('#chartGrid').find('div svg').find('*[zIndex=20], *[zIndex=21], *[zIndex=19]').toggle(editMode);

        runtime.chartAI++;
    }

    function PMA_getLogAnalyseDialog (min, max) {
        var $logAnalyseDialog = $('#logAnalyseDialog');
        var $dateStart = $logAnalyseDialog.find('input[name="dateStart"]');
        var $dateEnd = $logAnalyseDialog.find('input[name="dateEnd"]');
        $dateStart.prop('readonly', true);
        $dateEnd.prop('readonly', true);

        var dlgBtns = { };

        dlgBtns[messages.strFromSlowLog] = function () {
            loadLog('slow', min, max);
            $(this).dialog('close');
        };

        dlgBtns[messages.strFromGeneralLog] = function () {
            loadLog('general', min, max);
            $(this).dialog('close');
        };

        $logAnalyseDialog.dialog({
            width: 'auto',
            height: 'auto',
            buttons: dlgBtns
        });

        PMA_addDatepicker($dateStart, 'datetime', {
            showMillisec: false,
            showMicrosec: false,
            timeFormat: 'HH:mm:ss'
        });
        PMA_addDatepicker($dateEnd, 'datetime', {
            showMillisec: false,
            showMicrosec: false,
            timeFormat: 'HH:mm:ss'
        });
        $dateStart.datepicker('setDate', min);
        $dateEnd.datepicker('setDate', max);
    }

    function loadLog (type, min, max) {
        var dateStart = Date.parse($('#logAnalyseDialog').find('input[name="dateStart"]').datepicker('getDate')) || min;
        var dateEnd = Date.parse($('#logAnalyseDialog').find('input[name="dateEnd"]').datepicker('getDate')) || max;

        loadLogStatistics({
            src: type,
            start: dateStart,
            end: dateEnd,
            removeVariables: $('#removeVariables').prop('checked'),
            limitTypes: $('#limitTypes').prop('checked')
        });
    }

    /* Called in regular intervals, this function updates the values of each chart in the grid */
    function refreshChartGrid () {
        /* Send to server */
        runtime.refreshRequest = $.post('server_status_monitor.php' + CommonParams.get('common_query'), {
            ajax_request: true,
            chart_data: 1,
            type: 'chartgrid',
            requiredData: JSON.stringify(runtime.dataList),
            server: CommonParams.get('server')
        }, function (data) {
            var chartData;
            if (typeof data !== 'undefined' && data.success === true) {
                chartData = data.message;
            } else {
                return serverResponseError();
            }
            var value;
            var i = 0;
            var diff;
            var total;

            /* Update values in each graph */
            $.each(runtime.charts, function (orderKey, elem) {
                var key = elem.chartID;
                // If newly added chart, we have no data for it yet
                if (! chartData[key]) {
                    return;
                }
                // Draw all series
                total = 0;
                for (var j = 0; j < elem.nodes.length; j++) {
                    // Update x-axis
                    if (i === 0 && j === 0) {
                        if (oldChartData === null) {
                            diff = chartData.x - runtime.xmax;
                        } else {
                            diff = parseInt(chartData.x - oldChartData.x, 10);
                        }

                        runtime.xmin += diff;
                        runtime.xmax += diff;
                    }

                    // elem.chart.xAxis[0].setExtremes(runtime.xmin, runtime.xmax, false);
                    /* Calculate y value */

                    // If transform function given, use it
                    if (elem.nodes[j].transformFn) {
                        value = chartValueTransform(
                            elem.nodes[j].transformFn,
                            chartData[key][j],
                            // Check if first iteration (oldChartData==null), or if newly added chart oldChartData[key]==null
                            (
                                oldChartData === null ||
                                oldChartData[key] === null ||
                                oldChartData[key] === undefined ? null : oldChartData[key][j]
                            )
                        );

                    // Otherwise use original value and apply differential and divisor if given,
                    // in this case we have only one data point per series - located at chartData[key][j][0]
                    } else {
                        value = parseFloat(chartData[key][j][0].value);

                        if (elem.nodes[j].display === 'differential') {
                            if (oldChartData === null ||
                                oldChartData[key] === null ||
                                oldChartData[key] === undefined
                            ) {
                                continue;
                            }
                            value -= oldChartData[key][j][0].value;
                        }

                        if (elem.nodes[j].valueDivisor) {
                            value = value / elem.nodes[j].valueDivisor;
                        }
                    }

                    // Set y value, if defined
                    if (value !== undefined) {
                        elem.chart.series[j].data.push([chartData.x, value]);
                        if (value > elem.maxYLabel) {
                            elem.maxYLabel = value;
                        } else if (elem.maxYLabel === 0) {
                            elem.maxYLabel = 0.5;
                        }
                        // free old data point values and update maxYLabel
                        if (elem.chart.series[j].data.length > runtime.gridMaxPoints &&
                            elem.chart.series[j].data[0][0] < runtime.xmin
                        ) {
                            // check if the next freeable point is highest
                            if (elem.maxYLabel <= elem.chart.series[j].data[0][1]) {
                                elem.chart.series[j].data.splice(0, elem.chart.series[j].data.length - runtime.gridMaxPoints);
                                elem.maxYLabel = getMaxYLabel(elem.chart.series[j].data);
                            } else {
                                elem.chart.series[j].data.splice(0, elem.chart.series[j].data.length - runtime.gridMaxPoints);
                            }
                        }
                        if (elem.title === messages.strSystemMemory ||
                            elem.title === messages.strSystemSwap
                        ) {
                            total += value;
                        }
                    }
                }

                // update chart options
                // keep ticks number/positioning consistent while refreshrate changes
                var tickInterval = (runtime.xmax - runtime.xmin) / 5;
                elem.chart.axes.xaxis.ticks = [(runtime.xmax - tickInterval * 4),
                    (runtime.xmax - tickInterval * 3), (runtime.xmax - tickInterval * 2),
                    (runtime.xmax - tickInterval), runtime.xmax];

                if (elem.title !== messages.strSystemCPUUsage &&
                    elem.title !== messages.strQueryCacheEfficiency &&
                    elem.title !== messages.strSystemMemory &&
                    elem.title !== messages.strSystemSwap
                ) {
                    elem.chart.axes.yaxis.max = Math.ceil(elem.maxYLabel * 1.1);
                    elem.chart.axes.yaxis.tickInterval = Math.ceil(elem.maxYLabel * 1.1 / 5);
                } else if (elem.title === messages.strSystemMemory ||
                    elem.title === messages.strSystemSwap
                ) {
                    elem.chart.axes.yaxis.max = Math.ceil(total * 1.1 / 100) * 100;
                    elem.chart.axes.yaxis.tickInterval = Math.ceil(total * 1.1 / 5);
                }
                i++;

                if (runtime.redrawCharts) {
                    elem.chart.replot();
                }
            });

            oldChartData = chartData;

            runtime.refreshTimeout = setTimeout(refreshChartGrid, monitorSettings.gridRefresh);
        });
    }

    /* Function to get highest plotted point's y label, to scale the chart,
     * TODO: make jqplot's autoscale:true work here
     */
    function getMaxYLabel (dataValues) {
        var maxY = dataValues[0][1];
        $.each(dataValues, function (k, v) {
            maxY = (v[1] > maxY) ? v[1] : maxY;
        });
        return maxY;
    }

    /* Function that supplies special value transform functions for chart values */
    function chartValueTransform (name, cur, prev) {
        switch (name) {
        case 'cpu-linux':
            if (prev === null) {
                return undefined;
            }
            // cur and prev are datapoint arrays, but containing
            // only 1 element for cpu-linux
            cur = cur[0];
            prev = prev[0];

            var diff_total = cur.busy + cur.idle - (prev.busy + prev.idle);
            var diff_idle = cur.idle - prev.idle;
            return 100 * (diff_total - diff_idle) / diff_total;

        // Query cache efficiency (%)
        case 'qce':
            if (prev === null) {
                return undefined;
            }
            // cur[0].value is Qcache_hits, cur[1].value is Com_select
            var diffQHits = cur[0].value - prev[0].value;
            // No NaN please :-)
            if (cur[1].value - prev[1].value === 0) {
                return 0;
            }

            return diffQHits / (cur[1].value - prev[1].value + diffQHits) * 100;

        // Query cache usage (%)
        case 'qcu':
            if (cur[1].value === 0) {
                return 0;
            }
            // cur[0].value is Qcache_free_memory, cur[1].value is query_cache_size
            return 100 - cur[0].value / cur[1].value * 100;
        }
        return undefined;
    }

    /* Build list of nodes that need to be retrieved from server.
     * It creates something like a stripped down version of the runtime.charts object.
     */
    function buildRequiredDataList () {
        runtime.dataList = {};
        // Store an own id, because the property name is subject of reordering,
        // thus destroying our mapping with runtime.charts <=> runtime.dataList
        var chartID = 0;
        $.each(runtime.charts, function (key, chart) {
            runtime.dataList[chartID] = [];
            for (var i = 0, l = chart.nodes.length; i < l; i++) {
                runtime.dataList[chartID][i] = chart.nodes[i].dataPoints;
            }
            runtime.charts[key].chartID = chartID;
            chartID++;
        });
    }

    /* Loads the log table data, generates the table and handles the filters */
    function loadLogStatistics (opts) {
        var tableStr = '';
        var logRequest = null;

        if (! opts.removeVariables) {
            opts.removeVariables = false;
        }
        if (! opts.limitTypes) {
            opts.limitTypes = false;
        }

        $('#emptyDialog').dialog({ title: messages.strAnalysingLogsTitle });
        $('#emptyDialog').html(messages.strAnalysingLogs +
                                ' <img class="ajaxIcon" src="' + pmaThemeImage +
                                'ajax_clock_small.gif" alt="">');
        var dlgBtns = {};

        dlgBtns[messages.strCancelRequest] = function () {
            if (logRequest !== null) {
                logRequest.abort();
            }

            $(this).dialog('close');
        };

        $('#emptyDialog').dialog({
            width: 'auto',
            height: 'auto',
            buttons: dlgBtns
        });


        logRequest = $.get('server_status_monitor.php' + CommonParams.get('common_query'),
            {   ajax_request: true,
                log_data: 1,
                type: opts.src,
                time_start: Math.round(opts.start / 1000),
                time_end: Math.round(opts.end / 1000),
                removeVariables: opts.removeVariables,
                limitTypes: opts.limitTypes
            },
            function (data) {
                var logData;
                var dlgBtns = {};
                if (typeof data !== 'undefined' && data.success === true) {
                    logData = data.message;
                } else {
                    return serverResponseError();
                }

                if (logData.rows.length === 0) {
                    $('#emptyDialog').dialog({ title: messages.strNoDataFoundTitle });
                    $('#emptyDialog').html('<p>' + messages.strNoDataFound + '</p>');

                    dlgBtns[messages.strClose] = function () {
                        $(this).dialog('close');
                    };

                    $('#emptyDialog').dialog('option', 'buttons', dlgBtns);
                    return;
                }

                runtime.logDataCols = buildLogTable(logData, opts.removeVariables);

                /* Show some stats in the dialog */
                $('#emptyDialog').dialog({ title: messages.strLoadingLogs });
                $('#emptyDialog').html('<p>' + messages.strLogDataLoaded + '</p>');
                $.each(logData.sum, function (key, value) {
                    key = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
                    if (key === 'Total') {
                        key = '<b>' + key + '</b>';
                    }
                    $('#emptyDialog').append(key + ': ' + value + '<br/>');
                });

                /* Add filter options if more than a bunch of rows there to filter */
                if (logData.numRows > 12) {
                    $('#logTable').prepend(
                        '<fieldset id="logDataFilter">' +
                        '    <legend>' + messages.strFiltersForLogTable + '</legend>' +
                        '    <div class="formelement">' +
                        '        <label for="filterQueryText">' + messages.strFilterByWordRegexp + '</label>' +
                        '        <input name="filterQueryText" type="text" id="filterQueryText" style="vertical-align: baseline;" />' +
                        '    </div>' +
                        ((logData.numRows > 250) ? ' <div class="formelement"><button name="startFilterQueryText" id="startFilterQueryText">' + messages.strFilter + '</button></div>' : '') +
                        '    <div class="formelement">' +
                        '       <input type="checkbox" id="noWHEREData" name="noWHEREData" value="1" /> ' +
                        '       <label for="noWHEREData"> ' + messages.strIgnoreWhereAndGroup + '</label>' +
                        '   </div' +
                        '</fieldset>'
                    );

                    $('#noWHEREData').on('change', function () {
                        filterQueries(true);
                    });

                    if (logData.numRows > 250) {
                        $('#startFilterQueryText').on('click', filterQueries);
                    } else {
                        $('#filterQueryText').on('keyup', filterQueries);
                    }
                }

                dlgBtns[messages.strJumpToTable] = function () {
                    $(this).dialog('close');
                    $(document).scrollTop($('#logTable').offset().top);
                };

                $('#emptyDialog').dialog('option', 'buttons', dlgBtns);
            }
        );

        /* Handles the actions performed when the user uses any of the
         * log table filters which are the filter by name and grouping
         * with ignoring data in WHERE clauses
         *
         * @param boolean Should be true when the users enabled or disabled
         *                to group queries ignoring data in WHERE clauses
        */
        function filterQueries (varFilterChange) {
            var cell;
            var textFilter;
            var val = $('#filterQueryText').val();

            if (val.length === 0) {
                textFilter = null;
            } else {
                try {
                    textFilter = new RegExp(val, 'i');
                    $('#filterQueryText').removeClass('error');
                } catch (e) {
                    if (e instanceof SyntaxError) {
                        $('#filterQueryText').addClass('error');
                        textFilter = null;
                    }
                }
            }

            var rowSum = 0;
            var totalSum = 0;
            var i = 0;
            var q;
            var noVars = $('#noWHEREData').prop('checked');
            var equalsFilter = /([^=]+)=(\d+|((\'|"|).*?[^\\])\4((\s+)|$))/gi;
            var functionFilter = /([a-z0-9_]+)\(.+?\)/gi;
            var filteredQueries = {};
            var filteredQueriesLines = {};
            var hide = false;
            var rowData;
            var queryColumnName = runtime.logDataCols[runtime.logDataCols.length - 2];
            var sumColumnName = runtime.logDataCols[runtime.logDataCols.length - 1];
            var isSlowLog = opts.src === 'slow';
            var columnSums = {};

            // For the slow log we have to count many columns (query_time, lock_time, rows_examined, rows_sent, etc.)
            var countRow = function (query, row) {
                var cells = row.match(/<td>(.*?)<\/td>/gi);
                if (!columnSums[query]) {
                    columnSums[query] = [0, 0, 0, 0];
                }

                // lock_time and query_time and displayed in timespan format
                columnSums[query][0] += timeToSec(cells[2].replace(/(<td>|<\/td>)/gi, ''));
                columnSums[query][1] += timeToSec(cells[3].replace(/(<td>|<\/td>)/gi, ''));
                // rows_examind and rows_sent are just numbers
                columnSums[query][2] += parseInt(cells[4].replace(/(<td>|<\/td>)/gi, ''), 10);
                columnSums[query][3] += parseInt(cells[5].replace(/(<td>|<\/td>)/gi, ''), 10);
            };

            // We just assume the sql text is always in the second last column, and that the total count is right of it
            $('#logTable').find('table tbody tr td:nth-child(' + (runtime.logDataCols.length - 1) + ')').each(function () {
                var $t = $(this);
                // If query is a SELECT and user enabled or disabled to group
                // queries ignoring data in where statements, we
                // need to re-calculate the sums of each row
                if (varFilterChange && $t.html().match(/^SELECT/i)) {
                    if (noVars) {
                        // Group on => Sum up identical columns, and hide all but 1

                        q = $t.text().replace(equalsFilter, '$1=...$6').trim();
                        q = q.replace(functionFilter, ' $1(...)');

                        // Js does not specify a limit on property name length,
                        // so we can abuse it as index :-)
                        if (filteredQueries[q]) {
                            filteredQueries[q] += parseInt($t.next().text(), 10);
                            totalSum += parseInt($t.next().text(), 10);
                            hide = true;
                        } else {
                            filteredQueries[q] = parseInt($t.next().text(), 10);
                            filteredQueriesLines[q] = i;
                            $t.text(q);
                        }
                        if (isSlowLog) {
                            countRow(q, $t.parent().html());
                        }
                    } else {
                        // Group off: Restore original columns

                        rowData = $t.parent().data('query');
                        // Restore SQL text
                        $t.text(rowData[queryColumnName]);
                        // Restore total count
                        $t.next().text(rowData[sumColumnName]);
                        // Restore slow log columns
                        if (isSlowLog) {
                            $t.parent().children('td:nth-child(3)').text(rowData.query_time);
                            $t.parent().children('td:nth-child(4)').text(rowData.lock_time);
                            $t.parent().children('td:nth-child(5)').text(rowData.rows_sent);
                            $t.parent().children('td:nth-child(6)').text(rowData.rows_examined);
                        }
                    }
                }

                // If not required to be hidden, do we need
                // to hide because of a not matching text filter?
                if (! hide && (textFilter !== null && ! textFilter.exec($t.text()))) {
                    hide = true;
                }

                // Now display or hide this column
                if (hide) {
                    $t.parent().css('display', 'none');
                } else {
                    totalSum += parseInt($t.next().text(), 10);
                    rowSum++;
                    $t.parent().css('display', '');
                }

                hide = false;
                i++;
            });

            // We finished summarizing counts => Update count values of all grouped entries
            if (varFilterChange) {
                if (noVars) {
                    var numCol;
                    var row;
                    var $table = $('#logTable').find('table tbody');
                    $.each(filteredQueriesLines, function (key, value) {
                        if (filteredQueries[key] <= 1) {
                            return;
                        }

                        row =  $table.children('tr:nth-child(' + (value + 1) + ')');
                        numCol = row.children(':nth-child(' + (runtime.logDataCols.length) + ')');
                        numCol.text(filteredQueries[key]);

                        if (isSlowLog) {
                            row.children('td:nth-child(3)').text(secToTime(columnSums[key][0]));
                            row.children('td:nth-child(4)').text(secToTime(columnSums[key][1]));
                            row.children('td:nth-child(5)').text(columnSums[key][2]);
                            row.children('td:nth-child(6)').text(columnSums[key][3]);
                        }
                    });
                }

                $('#logTable').find('table').trigger('update');
                setTimeout(function () {
                    $('#logTable').find('table').trigger('sorton', [[[runtime.logDataCols.length - 1, 1]]]);
                }, 0);
            }

            // Display some stats at the bottom of the table
            $('#logTable').find('table tfoot tr')
                .html('<th colspan="' + (runtime.logDataCols.length - 1) + '">' +
                      messages.strSumRows + ' ' + rowSum + '<span class="floatright">' +
                      messages.strTotal + '</span></th><th class="right">' + totalSum + '</th>');
        }
    }

    /* Turns a timespan (12:12:12) into a number */
    function timeToSec (timeStr) {
        var time = timeStr.split(':');
        return (parseInt(time[0], 10) * 3600) + (parseInt(time[1], 10) * 60) + parseInt(time[2], 10);
    }

    /* Turns a number into a timespan (100 into 00:01:40) */
    function secToTime (timeInt) {
        var hours = Math.floor(timeInt / 3600);
        timeInt -= hours * 3600;
        var minutes = Math.floor(timeInt / 60);
        timeInt -= minutes * 60;

        if (hours < 10) {
            hours = '0' + hours;
        }
        if (minutes < 10) {
            minutes = '0' + minutes;
        }
        if (timeInt < 10) {
            timeInt = '0' + timeInt;
        }

        return hours + ':' + minutes + ':' + timeInt;
    }

    /* Constructs the log table out of the retrieved server data */
    function buildLogTable (data, groupInserts) {
        var rows = data.rows;
        var cols = [];
        var $table = $('<table class="sortable"></table>');
        var $tBody;
        var $tRow;
        var $tCell;

        $('#logTable').html($table);

        var tempPushKey = function (key, value) {
            cols.push(key);
        };

        var formatValue = function (name, value) {
            if (name === 'user_host') {
                return value.replace(/(\[.*?\])+/g, '');
            }
            return escapeHtml(value);
        };

        for (var i = 0, l = rows.length; i < l; i++) {
            if (i === 0) {
                $.each(rows[0], tempPushKey);
                $table.append('<thead>' +
                              '<tr><th class="nowrap">' + cols.join('</th><th class="nowrap">') + '</th></tr>' +
                              '</thead>'
                );

                $table.append($tBody = $('<tbody></tbody>'));
            }

            $tBody.append($tRow = $('<tr class="noclick"></tr>'));
            var cl = '';
            for (var j = 0, ll = cols.length; j < ll; j++) {
                // Assuming the query column is the second last
                if (j === cols.length - 2 && rows[i][cols[j]].match(/^SELECT/i)) {
                    $tRow.append($tCell = $('<td class="linkElem">' + formatValue(cols[j], rows[i][cols[j]]) + '</td>'));
                    $tCell.on('click', openQueryAnalyzer);
                } else {
                    $tRow.append('<td>' + formatValue(cols[j], rows[i][cols[j]]) + '</td>');
                }

                $tRow.data('query', rows[i]);
            }
        }

        $table.append('<tfoot>' +
                    '<tr><th colspan="' + (cols.length - 1) + '">' + messages.strSumRows +
                    ' ' + data.numRows + '<span class="floatright">' + messages.strTotal +
                    '</span></th><th class="right">' + data.sum.TOTAL + '</th></tr></tfoot>');

        // Append a tooltip to the count column, if there exist one
        if ($('#logTable').find('tr:first th:last').text().indexOf('#') > -1) {
            $('#logTable').find('tr:first th:last').append('&nbsp;' + PMA_getImage('b_help', '', { 'class': 'qroupedQueryInfoIcon' }));

            var tooltipContent = messages.strCountColumnExplanation;
            if (groupInserts) {
                tooltipContent += '<p>' + messages.strMoreCountColumnExplanation + '</p>';
            }

            PMA_tooltip(
                $('img.qroupedQueryInfoIcon'),
                'img',
                tooltipContent
            );
        }

        $('#logTable').find('table').tablesorter({
            sortList: [[cols.length - 1, 1]],
            widgets: ['fast-zebra']
        });

        $('#logTable').find('table thead th')
            .append('<div class="sorticon"></div>');

        return cols;
    }

    /* Opens the query analyzer dialog */
    function openQueryAnalyzer () {
        var rowData = $(this).parent().data('query');
        var query = rowData.argument || rowData.sql_text;

        if (codemirror_editor) {
            // TODO: somehow PMA_SQLPrettyPrint messes up the query, needs be fixed
            // query = PMA_SQLPrettyPrint(query);
            codemirror_editor.setValue(query);
            // Codemirror is bugged, it doesn't refresh properly sometimes.
            // Following lines seem to fix that
            setTimeout(function () {
                codemirror_editor.refresh();
            }, 50);
        } else {
            $('#sqlquery').val(query);
        }

        var profilingChart = null;
        var dlgBtns = {};

        dlgBtns[messages.strAnalyzeQuery] = function () {
            loadQueryAnalysis(rowData);
        };
        dlgBtns[messages.strClose] = function () {
            $(this).dialog('close');
        };

        $('#queryAnalyzerDialog').dialog({
            width: 'auto',
            height: 'auto',
            resizable: false,
            buttons: dlgBtns,
            close: function () {
                if (profilingChart !== null) {
                    profilingChart.destroy();
                }
                $('#queryAnalyzerDialog').find('div.placeHolder').html('');
                if (codemirror_editor) {
                    codemirror_editor.setValue('');
                } else {
                    $('#sqlquery').val('');
                }
            }
        });
    }

    /* Loads and displays the analyzed query data */
    function loadQueryAnalysis (rowData) {
        var db = rowData.db || '';

        $('#queryAnalyzerDialog').find('div.placeHolder').html(
            messages.strAnalyzing + ' <img class="ajaxIcon" src="' +
            pmaThemeImage + 'ajax_clock_small.gif" alt="">');

        $.post('server_status_monitor.php' + CommonParams.get('common_query'), {
            ajax_request: true,
            query_analyzer: true,
            query: codemirror_editor ? codemirror_editor.getValue() : $('#sqlquery').val(),
            database: db,
            server: CommonParams.get('server')
        }, function (data) {
            var i;
            var l;
            if (typeof data !== 'undefined' && data.success === true) {
                data = data.message;
            }
            if (data.error) {
                if (data.error.indexOf('1146') !== -1 || data.error.indexOf('1046') !== -1) {
                    data.error = messages.strServerLogError;
                }
                $('#queryAnalyzerDialog').find('div.placeHolder').html('<div class="error">' + data.error + '</div>');
                return;
            }
            var totalTime = 0;
            // Float sux, I'll use table :(
            $('#queryAnalyzerDialog').find('div.placeHolder')
                .html('<table width="100%" border="0"><tr><td class="explain"></td><td class="chart"></td></tr></table>');

            var explain = '<b>' + messages.strExplainOutput + '</b> ' + $('#explain_docu').html();
            if (data.explain.length > 1) {
                explain += ' (';
                for (i = 0; i < data.explain.length; i++) {
                    if (i > 0) {
                        explain += ', ';
                    }
                    explain += '<a href="#showExplain-' + i + '">' + i + '</a>';
                }
                explain += ')';
            }
            explain += '<p></p>';

            var tempExplain = function (key, value) {
                value = (value === null) ? 'null' : escapeHtml(value);

                if (key === 'type' && value.toLowerCase() === 'all') {
                    value = '<span class="attention">' + value + '</span>';
                }
                if (key === 'Extra') {
                    value = value.replace(/(using (temporary|filesort))/gi, '<span class="attention">$1</span>');
                }
                explain += key + ': ' + value + '<br />';
            };

            for (i = 0, l = data.explain.length; i < l; i++) {
                explain += '<div class="explain-' + i + '"' + (i > 0 ?  'style="display:none;"' : '') + '>';
                $.each(data.explain[i], tempExplain);
                explain += '</div>';
            }

            explain += '<p><b>' + messages.strAffectedRows + '</b> ' + data.affectedRows;

            $('#queryAnalyzerDialog').find('div.placeHolder td.explain').append(explain);

            $('#queryAnalyzerDialog').find('div.placeHolder a[href*="#showExplain"]').on('click', function () {
                var id = $(this).attr('href').split('-')[1];
                $(this).parent().find('div[class*="explain"]').hide();
                $(this).parent().find('div[class*="explain-' + id + '"]').show();
            });

            if (data.profiling) {
                var chartData = [];
                var numberTable = '<table class="queryNums"><thead><tr><th>' + messages.strStatus + '</th><th>' + messages.strTime + '</th></tr></thead><tbody>';
                var duration;
                var otherTime = 0;

                for (i = 0, l = data.profiling.length; i < l; i++) {
                    duration = parseFloat(data.profiling[i].duration);

                    totalTime += duration;

                    numberTable += '<tr><td>' + data.profiling[i].state + ' </td><td> ' + PMA_prettyProfilingNum(duration, 2) + '</td></tr>';
                }

                // Only put those values in the pie which are > 2%
                for (i = 0, l = data.profiling.length; i < l; i++) {
                    duration = parseFloat(data.profiling[i].duration);

                    if (duration / totalTime > 0.02) {
                        chartData.push([PMA_prettyProfilingNum(duration, 2) + ' ' + data.profiling[i].state, duration]);
                    } else {
                        otherTime += duration;
                    }
                }

                if (otherTime > 0) {
                    chartData.push([PMA_prettyProfilingNum(otherTime, 2) + ' ' + messages.strOther, otherTime]);
                }

                numberTable += '<tr><td><b>' + messages.strTotalTime + '</b></td><td>' + PMA_prettyProfilingNum(totalTime, 2) + '</td></tr>';
                numberTable += '</tbody></table>';

                $('#queryAnalyzerDialog').find('div.placeHolder td.chart').append(
                    '<b>' + messages.strProfilingResults + ' ' + $('#profiling_docu').html() + '</b> ' +
                    '(<a href="#showNums">' + messages.strTable + '</a>, <a href="#showChart">' + messages.strChart + '</a>)<br/>' +
                    numberTable + ' <div id="queryProfiling"></div>');

                $('#queryAnalyzerDialog').find('div.placeHolder a[href="#showNums"]').on('click', function () {
                    $('#queryAnalyzerDialog').find('#queryProfiling').hide();
                    $('#queryAnalyzerDialog').find('table.queryNums').show();
                    return false;
                });

                $('#queryAnalyzerDialog').find('div.placeHolder a[href="#showChart"]').on('click', function () {
                    $('#queryAnalyzerDialog').find('#queryProfiling').show();
                    $('#queryAnalyzerDialog').find('table.queryNums').hide();
                    return false;
                });

                profilingChart = createProfilingChart(
                    'queryProfiling',
                    chartData
                );

                // $('#queryProfiling').resizable();
            }
        });
    }

    /* Saves the monitor to localstorage */
    function saveMonitor () {
        var gridCopy = {};
        $.each(runtime.charts, function (key, elem) {
            gridCopy[key] = {};
            gridCopy[key].nodes = elem.nodes;
            gridCopy[key].settings = elem.settings;
            gridCopy[key].title = elem.title;
            gridCopy[key].series = elem.series;
            gridCopy[key].maxYLabel = elem.maxYLabel;
        });

        if (isStorageSupported('localStorage')) {
            window.localStorage.monitorCharts = JSON.stringify(gridCopy);
            window.localStorage.monitorSettings = JSON.stringify(monitorSettings);
            window.localStorage.monitorVersion = monitorProtocolVersion;
        }

        $('a[href="#clearMonitorConfig"]').show();
    }
}

// Run the monitor once loaded
export function onload4 () {
    $('a[href="#pauseCharts"]').trigger('click');
}

function serverResponseError () {
    var btns = {};
    btns[messages.strReloadPage] = function () {
        window.location.reload();
    };
    $('#emptyDialog').dialog({ title: messages.strRefreshFailed });
    $('#emptyDialog').html(
        PMA_getImage('s_attention') +
        messages.strInvalidResponseExplanation
    );
    $('#emptyDialog').dialog({ buttons: btns });
}

/* Destroys all monitor related resources */
function destroyGrid () {
    if (runtime.charts) {
        $.each(runtime.charts, function (key, value) {
            try {
                value.chart.destroy();
            } catch (err) {}
        });
    }

    try {
        runtime.refreshRequest.abort();
    } catch (err) {}
    try {
        clearTimeout(runtime.refreshTimeout);
    } catch (err) {}
    $('#chartGrid').html('');
    runtime.charts = null;
    runtime.chartAI = 0;
    /* monitorSettings = null; */ // TODO:this not global variable
}