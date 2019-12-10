import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  OnDestroy,
  OnInit, Output,
  ViewChild,
} from '@angular/core';
import * as vis from 'vis';
import { DataGroup, DataItem, DataSelectionOptions, IdType, Timeline, TimelineOptions } from 'vis';
import * as moment from 'moment';
import { LabelsService } from 'src/app/labels/labels.service';
import { CurrentProjectService } from '../current-project.service';
import { VideoService } from '../../video/video.service';
import { Subscription } from 'rxjs';
import { IMediaSubscriptions } from 'videogular2/src/core/vg-media/i-playable';
import { Hotkey, HotkeysService } from 'angular2-hotkeys';
import { ProjectModel } from '../../models/project.model';
import { Time } from './time';
import { TimelineData } from './timeline.data';
import _ from "lodash";
import { LabelModel } from '../../models/label.model';
import { pairwise, startWith } from 'rxjs/operators';
import { LabelCategoryModel } from '../../models/labelcategory.model';
import { element } from 'protractor';
import { CurrentToolService } from '../project-toolbox.service';
import { options } from './timeline.template.options';
import { forEach } from 'typescript-collections/dist/lib/arrays';

@Component({
  selector: 'app-timeline',
  templateUrl: './timeline.component.html',
  styleUrls: ['./timeline.component.scss']
})
export class TimelineComponent implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild('timeline_visualization') timelineVisualization: ElementRef;

  loading = true;
  private project: ProjectModel;
  private timeline: Timeline;

  @Output() showToolBox = new EventEmitter<boolean>();

  private timelineData: TimelineData = new TimelineData();
  private labelCategories: LabelCategoryModel[] = [];
  private customTimeId: IdType;
  private subscription: Subscription;
  private updateSubscription: Subscription;
  private currentTime = 0;
  private checkboxChange = new EventEmitter<{ id: IdType, checked: boolean }>();
  private userRole: string;

  constructor(private projectService: CurrentProjectService,
              private labelsService: LabelsService,
              private videoService: VideoService,
              private hotkeyService: HotkeysService,
              private changeDetectorRef: ChangeDetectorRef,
              private toolBoxService: CurrentToolService) {
  }

  ngOnInit(): void {
    this.updateSubscription = this.labelsService.newSegment$().subscribe(newSubject => {
      let hyperId = newSubject.hyperid;
      let id = newSubject.id;
      console.log(newSubject);
    });

    this.subscription = this.projectService.getCurrentProject$()
      .subscribe(project => {
        if (project) {
          this.project = project;
          this.userRole = this.projectService.findUserRole(project, JSON.parse(localStorage.getItem('currentSession$'))['user']['id']);
          this.labelsService.getLabelCategories()
            .then((labelCategories: LabelCategoryModel[]) => {
              labelCategories.map(labelCategory => {
                this.labelsService.getSegments(labelCategory.labels.map(x => {return x["_id"]}));
                this.timelineData.addGroups(labelCategory.labels.map(x => ({id: x["_id"], content: x.name, category: labelCategory.name, categoryId: labelCategory.id})));
                this.labelCategories.push(labelCategory);
              });
            });
        }
      });

    this.observeLabels();
    this.observeSegments();

    this.subscription.add(this.videoService.playerReady
      .subscribe(event => {
        const api = event.api;
        const index = event.index;
        if (api && index === 0) {
          const subscriptions: IMediaSubscriptions = api.subscriptions;
          this.subscription.add(subscriptions.canPlay.subscribe(() => {this.updateCurrentTime(Time.seconds(api.currentTime));}));
          this.subscription.add(subscriptions.timeUpdate.subscribe(() => {this.updateCurrentTime(Time.seconds(api.currentTime));}));
          this.subscription.add(subscriptions.durationChange.subscribe(() => {this.setMax(Time.seconds(api.duration));}));
        }
      }));

    this.subscription.add(this.checkboxChange
      .pipe(
        startWith({id: undefined, checked: false}),
        pairwise()
      )
      .subscribe(e => {
        const prev = e[0];
        const curr = e[1];

        if (prev && prev.id === undefined) {
          this.timelineData.startRecording(curr.id, this.currentTime);
        } else if (curr.checked) {
          this.timelineData.startRecording(curr.id, this.currentTime);
        } else if (!curr.checked) {
          this.stopRecording(curr);
        }
      }));

  }

  private stopRecording(curr) {
    this.timelineData.stopRecording(curr.id)
      .then((response: { id: IdType, updateExisting: boolean }) => {
        const item = this.timelineData.items.get(response.id);
        if (item && item.start != item.end) {
          let segment: any;
          segment = {
            hyperid: item.id,
            group: item.group,
            start: item.start,
            end: item.end,
            authorRole: this.userRole,
            authorId: JSON.parse(localStorage.getItem('currentSession$'))['user']['id'],
          };
          segment = response.updateExisting ? item : segment;
          let checkForMerges = this.updateRequired(this.timelineData.findItemsByOptions('group', item.group), segment, response.updateExisting);
          if (checkForMerges[0]) {
            this.handleSegmentMerge(checkForMerges);
          } else {
            this.createNewSegment(segment);
          }
        }
      }, (msg) => {
        console.log('an error occured while adding a segment:' + msg);
      });
  }

  private createNewSegment(segment: any) {
    this.labelsService.addSegment(segment).then((response) => {
      console.log('segment added' + response);
      this.timelineData.removeItem(segment.hyperid);
      segment.id = response;
      this.timelineData.updateItem(segment);
    }, function(err) {
      console.log('an error occured while adding a segment');
    });
  }

  private handleSegmentMerge(checkForMerges) {
    this.labelsService.mergeSegments(checkForMerges[1], checkForMerges[2], checkForMerges[3]).then(() => {
      let segment = this.timelineData.getItem(checkForMerges[1][0]);
      segment.start = checkForMerges[2];
      segment.end = checkForMerges[3];
      this.timelineData.updateItem(segment);
      for (let j = 1; j < checkForMerges[1].length; j++) {
        this.timelineData.removeItem(checkForMerges[1][j]);
      }
      this.timeline.redraw();
    }, () => {
      console.log('an error occured while merging the segment');
    });
  }

  ngAfterViewInit() {
    const container = this.timelineVisualization.nativeElement;
    // @ts-ignore
    this.timeline = new vis.Timeline(container, this.timelineData.items, this.timelineData.groups, options);
    this.customTimeId = this.timeline.addCustomTime(Time.seconds(1), 'currentPlayingTime');
    this.timeline.setCustomTimeTitle('seeker', this.customTimeId);


    this.timeline.on('timechanged', properties => {
      const videoSeek = Time.dateToTotalCentiSeconds(properties.time);
      this.videoService.seekTo(videoSeek);
      // this.timeline.setCustomTimeTitle(time.formatDatetime('H:mm:ss'), id); todo
    });

    this.timelineData.items.on('remove', (event, properties) => {
      if (event === 'remove') {
        const ids = properties.items;
        this.labelsService.deleteSegments(ids);
      }
    });

    this.loading = false;
    this.changeDetectorRef.detectChanges();

    this.registerHotkeys();

    // force a timeline redraw, because sometimes it does not detect changes
    setTimeout(() => {
      this.timeline.redraw();
      let elements = document.getElementsByClassName('vis-inner');

      // @ts-ignore
      for (let item of elements) {
        item.setAttribute('style', 'display: block;');
      }
    }, 250);
  }

  updateCurrentTime(millis: number) {
    // console.log(millis);
    this.currentTime = millis;

    this.timeline.setCustomTime(millis, this.customTimeId);
    const start = this.timeline.getWindow().start.getTime();
    const end = this.timeline.getWindow().end.getTime();

    const delta = 3 * (end - start) / 4; // center
    if (millis < start || end < millis + delta) {
      this.timeline.moveTo(millis, {animation: false});
      // this.timeline.moveTo(millis + (end - start) - (end - start) / 6);
    }

    this.timelineData.updateRecordings(millis);
  }

  ngOnDestroy(): void {
    if (this.timeline) {
      this.timeline.destroy();
    }
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  private observeLabels() {
    this.subscription.add(this.labelsService.newLabels$().subscribe(newLabel => {
      if (newLabel) {
        let category: LabelCategoryModel = this.labelCategories.find(value => value.id == newLabel['categoryId'] );
        if(category!= null) {
          category.labels.push(newLabel);
          const group = {id: newLabel.id, content: newLabel.name, category: category.name, categoryId: category.id};
          this.timelineData.addGroup(group);
          this.timelineData.sortByCategories();
        }
      }
    }));

    this.subscription.add(this.labelsService.newLabelCategories$().subscribe(newLabelCategories => {
      if (newLabelCategories) {
        const group = {id: newLabelCategories["labels"][0]["_id"], content: newLabelCategories["labels"][0]["name"], category: newLabelCategories.name, categoryId: newLabelCategories.id};
        this.timelineData.addGroup(group);
        this.labelCategories.push(newLabelCategories);
      }
    }));

    this.subscription.add(this.labelsService.removedLabels$().subscribe(removed => {
      if (removed) {
        this.timelineData.removeGroup(removed.id);
      }
    }));

    this.subscription.add(this.labelsService.removedLabelCategories$().subscribe(removed => {
      if (removed) {
        let removedCategory: LabelCategoryModel = this.labelCategories.find((labelCategory) => { return labelCategory.id === removed.id;});
        this.timelineData.deleteGroupCategory(removedCategory.id);
        removedCategory.labels.map( label => this.timelineData.removeGroup(label["_id"]));
        this.labelCategories.filter(item => item !== removedCategory);
      }
    }));

    this.subscription.add(this.labelsService.editedLabels$().subscribe(changed => {
        if (changed) {
          this.timelineData.updateGroup({id: changed.id, content: changed.change});
        }
      })
    );

    this.subscription.add(this.labelsService.editedLabelCategories$().subscribe(changed => {
        if (changed) {
          this.timelineData.updateGroupCategory(changed.change, changed.id);
          let category: LabelCategoryModel = this.labelCategories.find( item => item.id === changed.id);
          category.name = changed.change;
          category.labels.map( label => label.name = changed.change + '_' + label.name.split('_')[1]);
          this.timeline.redraw();
        }
      })
    );
  }

  private observeSegments() {
    this.subscription.add(
      this.labelsService.getSegments$()
        .subscribe(
          xs => this.timelineData.items.add(xs.map(x => ({
            id: x.id,
            content: '',
            group: x.labelId,
            start: x.start,
            end: x.end
          })))
        )
    );
  }

  private registerHotkeys() {
    const hotkeys = [];
    for (let i = 0; i < 9; ++i) {
      const hotkey = new Hotkey(
        `${i + 1}`,
        (): boolean => {
          const ids: IdType[] = this.timelineData.getGroupIds();
          const id = ids[i];
          const checkbox = document.getElementById(`checkbox_${id}`);
          if (checkbox) {
            checkbox.click();
          }
          return false;
        },
        undefined,
        `Toggle recording of the ${i + 1} label`);
      hotkeys.push(hotkey);
    }
    this.hotkeyService.add(hotkeys);

    const del = new Hotkey(
      `del`,
      (): boolean => {
        setTimeout(() => this.deleteSelecion(), 0);
        return false;
      },
      undefined,
      `Delete selected segments`);

    this.hotkeyService.add(del);
  }

  private setMax(duration: number) {
    // @ts-ignore
    const newOptions: TimelineOptions = Object.assign({}, options);
    newOptions.max = duration;
    this.timeline.setOptions(newOptions);
  }

  private deleteSelecion() {
    const selection = this.timeline.getSelection();
    if (selection && selection.length > 0) {
      if (confirm('Are you sure you want to delete selected segments?')) {
        this.timelineData.items.remove(selection);
      }
    }
  }

  private checkForTracking(categoryId: string) {
    let category: LabelCategoryModel = this.labelCategories.find(value => value.id == categoryId );
    this.toolBoxService.triggerToolBox(category.isTrackable);
  }


  //TODO CHECK IF THIS SECTION IS ACTUALLY REQUIRED
  private updateRequired(items: DataItem[], currentItem: any, updateExisting: boolean) {
    if(updateExisting) return this.existingItemMerge(items, currentItem);
    else {
      return this.mergeItemsForNewSegment(items, currentItem, false);
    }
  }

  private mergeSegments(currentItem: any, items: DataItem[], existingUpdate: boolean) {
    let itemList = [];
    let start: number = currentItem.start;
    let end: number = currentItem.end;
    if(existingUpdate) itemList.push(currentItem.id);
    items.forEach(segment => {
      let currentId = currentItem['id'] ? currentItem['id'] : currentItem['hyperid'];
      if (currentItem != segment && currentId != segment.id && (segment.start <= currentItem.end && segment.end >= currentItem.start)) {
        start = start < segment.start ? start : parseInt(segment.start.toString());
        end = end < segment.end ? parseInt(segment.end.toString()) : end;
        itemList.push(segment.id);
      }
    });
    return { itemList, start, end };
  }

  private existingItemMerge(items: DataItem[], currentItem: any) {
    if(items.length == 1) {
      return [true, [items[0].id], currentItem.start, currentItem.end];
    }
    return this.mergeItemsForNewSegment(items, currentItem, true);
  }

  private mergeItemsForNewSegment(items: DataItem[], currentItem: any, updateExisting: boolean) {
    if(items.length != 1)  {
      let { itemList, start, end } = this.mergeSegments(currentItem, items, updateExisting);
      if(itemList.length > 0) {
        itemList = updateExisting? _.sortBy(itemList, function(item) { return item.id === currentItem.id ? 0 : 1;}): itemList;
        return [true, itemList, start, end];
      }
      if(updateExisting)
        return [true, [currentItem.id], currentItem.start, currentItem.end];
    }
    return [false];
  }
}
